import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type {
  TestAuthor,
  TestAuthorInput,
  TestAuthorResult,
} from "../controller.js";
import type { WritableRepoTools } from "../tools.js";
import { buildImplementerTools } from "./implementer.js";

/**
 * M3 Trin 2 — the Tester. After the Implementer builds a backlog item in its
 * worktree, this seam authors a test that ACTUALLY EXERCISES the new code, in
 * that same worktree, before the Verifier runs. That turns "green" from "it
 * compiles / lints" into "a real test passed" — closing the gap the Verifier
 * alone can't see (code that builds but misimplements the intent).
 *
 * A ReAct loop on the prebuilt `createReactAgent`, reusing the implementer's
 * write-tool belt (rooted in the item's worktree), `recursionLimit`-terminated
 * so it can never wedge the mission loop. Crucially it ONLY authors tests: it
 * never reports pass/fail and the controller never reads a verdict from it — the
 * Verifier's exit code stays the sole truth of "done" (a test that fails the
 * buggy code keeps the item open, which is exactly the point).
 *
 * Core stays pure: it receives a `repo` FACTORY (worktree path → WritableRepoTools)
 * injected by the runtime, never an fs/git impl — mirroring how the work runner
 * gets `buildGraph(worktree)`.
 */

/**
 * Recursion limit for the ReAct loop — ~2 super-steps per model↔tool round-trip,
 * so this allows ~24 tool turns. Keeps the tester provably terminating.
 */
const RECURSION_LIMIT = 48;

const SYSTEM_PROMPT = `You are the Tester, an autonomous agent on a coding mission. The Implementer just
wrote code in a git worktree to satisfy ONE backlog item. Your single job: make
sure an automated test actually EXERCISES that change, so a green build is real
evidence the code works — not just that it compiles.

Tools:
- list_files, read_file, search_code — understand the change and the repo's
  existing test setup before you write anything. Inspect the real diff first:
  run_command("git", ["--no-pager", "diff"]) (and "git" ["add","-A","-N"] so new
  files show) to see exactly what the Implementer changed.
- write_file / apply_edit — create or extend a TEST file.
- run_check — run an allowlisted check (e.g. "test") to confirm your test runs.

Rules:
- Write a test that asserts the CORRECT behaviour the item + acceptance criteria
  demand, placed and named so the repo's existing test runner discovers it
  (match the project's conventions and imports — read an existing test if there is
  one). The test must genuinely call the new code, not just assert "true".
- You may ONLY create or edit TEST files — writes to non-test paths are REJECTED,
  so do not attempt to touch implementation/source code. If the implementation is
  wrong, your test SHOULD fail — that is the correct outcome; the Verifier will
  keep the item open. Do not weaken a test to make it pass, and do not try to
  "fix" the code to satisfy your own test (you can't, and shouldn't).
- If a real test already exercises this change, do nothing and say so — do not add
  a redundant or trivial test.
- Make the smallest meaningful test. When done, STOP calling tools and write a
  one-line summary of what you tested (or that an adequate test already existed).

LANGUAGE: Write the summary and any test comments in the same language as the
item — Danish if it is Danish, otherwise English. (Code, paths, commands as-is.)`;

const preview = (s: string, n = 140) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const asText = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);

function buildPrompt({ mission, item, result }: TestAuthorInput): string {
  const parts = [
    `# Backlog item just implemented\n${item.title}${item.detail ? `\n${item.detail}` : ""}`,
  ];
  if (mission.acceptanceCriteria.length > 0) {
    parts.push(
      `# Mission acceptance criteria\n${mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (result.draft) parts.push(`# Implementer's own summary\n${result.draft}`);
  parts.push(
    `# Your job\nInspect the actual change, then ensure an automated test exercises it. Author the test in this worktree so the project's test runner picks it up. Remember: only touch test files, and let a failing test stand if the code is wrong.`,
  );
  return parts.join("\n\n");
}

/**
 * Test-path conventions the tester's writes are confined to. Confining writes to
 * these turns "only edit test files" from a prompt instruction into a HARD
 * constraint: a tester that tries to "fix" the implementation so its own test
 * passes is rejected, so it can never smuggle an impl change into the merge —
 * which would defeat "green = strong truth". Matches `*.test.*` / `*.spec.*` /
 * `_test.` / `_spec.` files, a `test_` prefix, and `test`/`tests`/`spec`/`specs`/
 * `__tests__`/`e2e` directories. Pure string check — core does no fs.
 */
const TEST_PATH =
  /(^|\/)(__tests?__|tests?|specs?|e2e)(\/|$)|(\.|_|-)(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+$/i;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path.replace(/\\/g, "/"));

/**
 * Wrap writable tools so create/edit/delete is confined to test files; reads,
 * checks and commands pass through unchanged. A non-test write throws — surfaced
 * to the model as a tool error (nudging it to comply) and, crucially, never
 * reaching disk. The implementation source is structurally protected, not merely
 * asked to be left alone (the same capability-by-type discipline as `tools.ts`).
 */
function restrictWritesToTests(repo: WritableRepoTools): WritableRepoTools {
  const guard = (path: string) => {
    if (!isTestPath(path)) {
      throw new Error(
        `the Tester may only create or edit test files; '${path}' is not a recognised test path ` +
          `(use a *.test.* / *.spec.* file or a test/, tests/, spec/ or __tests__/ directory).`,
      );
    }
  };
  return {
    listFiles: (dir) => repo.listFiles(dir),
    readFile: (path, options) => repo.readFile(path, options),
    searchCode: (query) => repo.searchCode(query),
    runCheck: (name) => repo.runCheck(name),
    runCommand: (command, args) => repo.runCommand(command, args),
    writeFile: (path, content) => {
      guard(path);
      return repo.writeFile(path, content);
    },
    applyEdit: (path, oldString, newString) => {
      guard(path);
      return repo.applyEdit(path, oldString, newString);
    },
    deleteFile: (path) => {
      guard(path);
      return repo.deleteFile(path);
    },
  };
}

export interface MakeTestAuthorOptions {
  /**
   * Build worktree-rooted writable tools for the item being tested. Injected by
   * the runtime (e.g. `(wt) => createWritableRepoTools(wt, …)`) so core never
   * instantiates fs/git — same pattern as the work runner's `buildGraph`.
   */
  repo: (worktree: string) => WritableRepoTools;
}

export function makeTestAuthor(
  model: BaseChatModel,
  options: MakeTestAuthorOptions,
): TestAuthor {
  // A non-tool-calling model can't drive the write loop — degrade gracefully
  // rather than throw, so a misconfigured tester model never wedges the mission
  // (the Verifier simply runs whatever tests already exist).
  const canCall = typeof model.bindTools === "function";

  return {
    async authorTest(input: TestAuthorInput): Promise<TestAuthorResult> {
      const worktree = input.result.worktree;
      if (!worktree) return { authored: false, note: "no worktree to author a test in" };
      if (!canCall) {
        return { authored: false, note: "tester model does not support tool calling" };
      }

      // Reuse the implementer's tool belt, but over a repo whose writes are
      // confined to test files — the tester literally cannot edit impl source.
      const repo = restrictWritesToTests(options.repo(worktree));
      const agent = createReactAgent({
        llm: model,
        tools: buildImplementerTools(repo),
        prompt: SYSTEM_PROMPT,
      });

      let messages: BaseMessage[];
      try {
        const out = (await agent.invoke(
          { messages: [new HumanMessage(buildPrompt(input))] },
          { recursionLimit: RECURSION_LIMIT },
        )) as { messages: BaseMessage[] };
        messages = out.messages;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { authored: false, note: `test author did not converge: ${preview(reason)}` };
      }

      // A write tool-call that THREW (e.g. a non-test path, or a failed edit) is
      // returned by the ToolNode as an error ToolMessage, not a crash — so only
      // count a write as "authored" when its result didn't error, keeping the
      // journal note honest (it never gates control flow either way).
      const failed = new Set<string>();
      for (const m of messages) {
        if (isToolMessage(m) && (m as { status?: string }).status === "error" && m.tool_call_id) {
          failed.add(m.tool_call_id);
        }
      }

      let tokens = 0;
      let authored = false;
      let summary = "";
      for (const m of messages) {
        if (!isAIMessage(m)) continue;
        tokens += m.usage_metadata?.total_tokens ?? 0;
        const calls = m.tool_calls ?? [];
        for (const call of calls) {
          if (
            (call.name === "write_file" || call.name === "apply_edit") &&
            (!call.id || !failed.has(call.id))
          ) {
            authored = true;
          }
        }
        if (calls.length === 0) {
          const text = asText(m.content).trim();
          if (text) summary = text;
        }
      }

      return {
        authored,
        note: summary || (authored ? "authored a test" : "no test authored"),
        tokensUsed: tokens,
      };
    },
  };
}
