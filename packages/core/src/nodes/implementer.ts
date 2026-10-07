import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { AgentMessage, GraphStateType } from "../state.js";
import type { WritableRepoTools } from "../tools.js";
import { billableTokens } from "../tokens.js";

/**
 * Recursion limit for the ReAct loop — each model↔tool round-trip is ~2
 * super-steps, so this allows ~24 tool turns before the prebuilt agent stops.
 * Keeps the implementer provably terminating even if the model never settles.
 */
const RECURSION_LIMIT = 48;

/**
 * The ReAct loop can take several LLM↔tool round trips (up to ~24 turns per
 * RECURSION_LIMIT above), so a single flat per-call timeout sized for "one
 * message exchange" would cut it off far too early. Bound the WHOLE loop
 * generously instead of each turn individually — an outer safety net layered
 * on top of (not instead of) RECURSION_LIMIT.
 */
const IMPLEMENTER_TIMEOUT_MULTIPLIER = 8;

const SYSTEM_PROMPT = `You are the Implementer, an autonomous coding agent working DIRECTLY on a git
worktree. Unlike a planner, you produce real, running code: you write files, edit
them, and run commands — you do not describe changes, you make them.

Tools:
- list_files, read_file, search_code — understand the code before you touch it.
  Ground every change in what is actually there; never edit a file you haven't read.
  read_file takes offset/limit: on a large file, search_code first and read the
  window around the hit rather than pulling the whole file — everything you read
  stays in context for the rest of this task, so read what you need, not more.
- write_file — create or overwrite a file with full contents.
- apply_edit — replace ONE exact, unique snippet in a file (preferred for small,
  targeted changes). Include enough surrounding context to make the match unique.
  read_file prefixes each line with 'N→' for navigation; those prefixes are not
  in the file, so strip them from old_string or the match will fail.
- delete_file — remove a file.
- run_command — run an allowlisted executable (no shell), cwd = the worktree.
- run_check — run an allowlisted verification command (test/lint/typecheck/build)
  and read its REAL output.

Workflow: explore → make the change → run the relevant check → fix what the check
reports → repeat until the checks you can run are green. Make the smallest change
that satisfies the task. When the work is done and verified, STOP calling tools
and write a short final summary: what you changed (files) and what you verified.

LANGUAGE: Write your final summary in the same language as the task — Danish if
the task is in Danish, otherwise English. (Code, paths and commands stay as-is.)`;

function buildPrompt(state: GraphStateType): string {
  const parts = [`# Task\n${state.task}`];
  if (state.context) parts.push(`# Project context\n${state.context}`);
  if (state.draft) parts.push(`# Prior work / notes\n${state.draft}`);
  const issues = (state.verdict?.issues ?? []).map((i) => `- ${i}`);
  // The checks go first: they decide "done", and the notes above may claim a
  // success they never confirmed.
  const failed = state.failedVerification;
  if (failed) {
    issues.unshift(
      `- The previous attempt FAILED verification (${failed.check}). Whatever the notes above say, ` +
        `this item is not done until these checks pass. Their output:\n\`\`\`\n${failed.output}\n\`\`\``,
    );
  }
  if (issues.length > 0) {
    parts.push(`# Issues to fix (from verification/critic)\n${issues.join("\n")}`);
  }
  return parts.join("\n\n");
}

const preview = (s: string, n = 140) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const asText = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);

/**
 * The Implementer's tool belt: the read-only tools (same as the analyst) PLUS
 * the M2 write tools, wrapping an injected `WritableRepoTools`. Exported so the
 * glue (each tool actually calls through to the repo) can be proven without a
 * live model.
 */
export function buildImplementerTools(
  repo: WritableRepoTools,
): StructuredToolInterface[] {
  return [
    tool(async ({ dir }: { dir?: string }) => repo.listFiles(dir ?? "."), {
      name: "list_files",
      description:
        "List files and folders in a directory (relative to the worktree root). Folders end with '/'. Use '.' for the root.",
      schema: z.object({
        dir: z.string().optional().describe("Directory relative to root; defaults to '.'"),
      }),
    }),
    tool(
      async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) =>
        repo.readFile(path, { offset, limit }),
      {
        name: "read_file",
        description:
          "Read a UTF-8 text file relative to the worktree root. Returns lines prefixed 'N→' " +
          "for navigation; reads a window from the start by default and tells you the offset to " +
          "continue from. Pass offset/limit to jump straight to the part you need instead of " +
          "pulling a whole large file. IMPORTANT: the 'N→' prefixes are display only and are NOT " +
          "in the file — strip them before using any of this text as apply_edit's old_string.",
        schema: z.object({
          path: z.string().describe("File path relative to root"),
          offset: z.number().int().min(1).optional().describe("1-based first line to read; defaults to 1"),
          limit: z.number().int().min(1).optional().describe("Maximum lines to return; defaults to a few hundred"),
        }),
      },
    ),
    tool(
      async ({ query, context }: { query: string; context?: number }) =>
        repo.searchCode(query, { context }),
      {
        name: "search_code",
        description:
          "Case-insensitive substring search across the worktree. Each hit comes with a few lines of " +
          "surrounding context: 'path:line: text' is a match, 'path:line- text' is context. Usually " +
          "enough to judge a hit without reading the file. Pass context:0 when you only need to count " +
          "call sites, or a larger context when you need to see more around each one.",
        schema: z.object({
          query: z.string().describe("Substring to search for"),
          context: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe("Lines of context around each match; defaults to a few"),
        }),
      },
    ),
    tool(
      async ({ path, content }: { path: string; content: string }) =>
        repo.writeFile(path, content),
      {
        name: "write_file",
        description:
          "Create or overwrite a file with the given full contents (parent dirs are created). Use for new files or full rewrites.",
        schema: z.object({
          path: z.string().describe("File path relative to root"),
          content: z.string().describe("Full UTF-8 file contents"),
        }),
      },
    ),
    tool(
      async ({
        path,
        old_string,
        new_string,
      }: {
        path: string;
        old_string: string;
        new_string: string;
      }) => repo.applyEdit(path, old_string, new_string),
      {
        name: "apply_edit",
        description:
          "Replace ONE exact, unique occurrence of old_string with new_string in a file. Fails if old_string is absent or appears more than once — include surrounding context to make it unique.",
        schema: z.object({
          path: z.string().describe("File path relative to root"),
          old_string: z.string().describe("Exact text to replace (must be unique in the file)"),
          new_string: z.string().describe("Replacement text"),
        }),
      },
    ),
    tool(async ({ path }: { path: string }) => repo.deleteFile(path), {
      name: "delete_file",
      description: "Delete a file relative to the worktree root.",
      schema: z.object({ path: z.string().describe("File path relative to root") }),
    }),
    tool(
      async ({ command, args }: { command: string; args?: string[] }) =>
        repo.runCommand(command, args ?? []),
      {
        name: "run_command",
        description:
          "Run an allowlisted executable (e.g. git, node, pnpm) with literal arguments and NO shell, cwd = the worktree. Returns the command, exit status and output.",
        schema: z.object({
          command: z.string().describe("Executable name, e.g. 'git' or 'pnpm'"),
          args: z.array(z.string()).optional().describe("Arguments passed verbatim (no shell)"),
        }),
      },
    ),
    tool(async ({ name }: { name: string }) => repo.runCheck(name), {
      name: "run_check",
      description:
        "Run an allowlisted verification command (test/lint/typecheck/build) and read its output + exit status. Use to confirm the change works.",
      schema: z.object({
        name: z.string().describe("Check to run, e.g. 'test', 'lint', 'typecheck', 'build'"),
      }),
    }),
  ];
}

/**
 * A hint appended to the system prompt when extra tools are injected — so the
 * implementer knows to REACH FOR them (e.g. a daisyUI / design-system knowledge
 * base) rather than inventing UI markup. The tools are already described to the
 * model by `createReactAgent`; this just sets the policy for when to prefer them.
 */
const EXTRA_TOOLS_HINT = `

Extra tools may be available beyond the file/command tools above — e.g. a UI
component or design-system knowledge base. When your task involves UI, PREFER
those tools to fetch correct, on-brand markup/snippets instead of inventing it:
call the tool, then write the files with what it returns.`;

/**
 * Mission-only implementer node (M2 build-order Trin 3). A ReAct loop built on
 * the prebuilt `createReactAgent`, driving the write-capable tools to author and
 * verify real code in a worktree. Distinct from the text-only builder/worker
 * nodes: it is handed a `WritableRepoTools`, so write capability never leaks into
 * a non-mission flow. Returns the model's final summary as `draft` and a trace
 * of the tool calls for the messages channel.
 *
 * @param extraTools additional tools merged into the belt (M4: MCP servers such
 * as a daisyUI blueprint), injected by the runtime — additive, best-effort.
 */
export function makeImplementerNode(
  model: BaseChatModel,
  repo: WritableRepoTools,
  extraTools: StructuredToolInterface[] = [],
  llmCallTimeoutMs: number = DEFAULT_LLM_CALL_TIMEOUT_MS,
) {
  if (typeof model.bindTools !== "function") {
    throw new Error("The configured LLM does not support tool calling (bindTools).");
  }
  // Extra tools (M4: injected MCP servers, e.g. a daisyUI blueprint) join the belt
  // AFTER the file/command tools — additive, they never replace write capability.
  const tools = [...buildImplementerTools(repo), ...extraTools];
  const prompt = extraTools.length > 0 ? SYSTEM_PROMPT + EXTRA_TOOLS_HINT : SYSTEM_PROMPT;
  const agent = createReactAgent({ llm: model, tools, prompt });

  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    let messages: BaseMessage[];
    try {
      const result = (await withLlmTimeout(
        agent.invoke(
          { messages: [new HumanMessage(buildPrompt(state))] },
          { recursionLimit: RECURSION_LIMIT, signal: config?.signal },
        ),
        llmCallTimeoutMs * IMPLEMENTER_TIMEOUT_MULTIPLIER,
        "implementer",
      )) as { messages: BaseMessage[] };
      messages = result.messages;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        draft: `Implementer did not converge: ${reason}`,
        round: state.round + 1,
        status: "running",
        messages: [
          { agent: "implementer", role: "assistant", content: `⚠️ implementer error: ${preview(reason)}` },
        ],
      };
    }

    // Pair tool results back to their calls for a readable trace.
    const resultById = new Map<string, string>();
    for (const m of messages) {
      if (isToolMessage(m)) resultById.set(m.tool_call_id, asText(m.content));
    }

    let tokens = 0;
    const trace: AgentMessage[] = [];
    let report = "";
    for (const m of messages) {
      if (!isAIMessage(m)) continue;
      tokens += billableTokens(m.usage_metadata);
      const calls = m.tool_calls ?? [];
      for (const call of calls) {
        const res = call.id ? (resultById.get(call.id) ?? "") : "";
        trace.push({
          agent: "implementer",
          role: "assistant",
          content: `🔧 ${call.name}(${preview(JSON.stringify(call.args), 60)}) → ${preview(res)}`,
        });
      }
      if (calls.length === 0) {
        const text = asText(m.content).trim();
        if (text) report = text;
      }
    }

    if (!report) report = "(implementer produced no final summary)";

    return {
      draft: report,
      round: state.round + 1,
      tokensUsed: state.tokensUsed + tokens,
      status: "running",
      messages: [...trace, { agent: "implementer", role: "assistant", content: report }],
    };
  };
}
