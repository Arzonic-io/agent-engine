import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, isAIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { RepoTools } from "../tools.js";

/**
 * The read-only half of the tool belt — list/read/search/check, no writes and no
 * arbitrary commands. Shared by every node that must GROUND itself in the repo
 * without being able to change it (the analyst, and the planners via `surveyRepo`).
 * Takes a `RepoTools`, so a caller structurally cannot hand a planner write
 * capability by accident: the object it gets has no write methods to call.
 *
 * @param rootNoun what the paths are relative to, for the tool descriptions —
 * "repo root" when reading the checkout, "worktree root" inside an item's worktree.
 */
export function buildReadOnlyTools(
  repo: RepoTools,
  rootNoun = "repo root",
): StructuredToolInterface[] {
  return [
    tool(async ({ dir }: { dir?: string }) => repo.listFiles(dir ?? "."), {
      name: "list_files",
      description: `List files and folders in a directory (relative to the ${rootNoun}). Folders end with '/'. Use '.' for the root.`,
      schema: z.object({
        dir: z.string().optional().describe(`Directory relative to the ${rootNoun}; defaults to '.'`),
      }),
    }),
    tool(
      async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) =>
        repo.readFile(path, { offset, limit }),
      {
        name: "read_file",
        description:
          `Read a UTF-8 text file relative to the ${rootNoun}. Returns lines prefixed 'N→' (display ` +
          "only, not file content); reads a window from the start by default and tells you the offset " +
          "to continue from. Pass offset/limit to read the part you need of a large file instead of all of it.",
        schema: z.object({
          path: z.string().describe(`File path relative to the ${rootNoun}`),
          offset: z.number().int().min(1).optional().describe("1-based first line to read; defaults to 1"),
          limit: z.number().int().min(1).optional().describe("Maximum lines to return; defaults to a few hundred"),
        }),
      },
    ),
    tool(async ({ query }: { query: string }) => repo.searchCode(query), {
      name: "search_code",
      description: `Case-insensitive substring search across the ${rootNoun}. Returns matching 'path:line: text' hits.`,
      schema: z.object({ query: z.string().describe("Substring to search for") }),
    }),
    tool(async ({ name }: { name: string }) => repo.runCheck(name), {
      name: "run_check",
      description:
        "Run an allowlisted verification command (test/lint/typecheck/build) and read its output + exit " +
        "status. Use to learn which checks EXIST and currently pass, so a plan can name a real one.",
      schema: z.object({
        name: z.string().describe("Check to run, e.g. 'test', 'lint', 'typecheck', 'build'"),
      }),
    }),
  ];
}

/**
 * A survey is cheap relative to what it saves, but it is not the work — bound it
 * tighter than the implementer's loop (~12 tool turns vs ~24). A planner that
 * needs more than that is doing the implementer's job.
 */
const RECURSION_LIMIT = 24;
const SURVEY_TIMEOUT_MULTIPLIER = 4;

const SYSTEM_PROMPT = `You are surveying an existing codebase so that a precise plan can be written
against it. You are NOT writing the plan and NOT changing anything — you are
establishing facts the planner would otherwise have to guess.

Explore with the tools, then report ONLY what you actually verified:
- The files and symbols the work would touch, by exact path (and line where useful).
- How the relevant code works today — the existing pattern to follow or replace.
- Which allowlisted check (test/lint/typecheck/build) would prove the work correct,
  and whether it passes right now.
- Anything that makes this harder than it looks: call sites that must move together,
  persisted shapes, contracts other code depends on.

Be specific and short. Cite paths, not impressions. If you could not confirm
something, say so plainly instead of guessing — an honest gap is more useful to
the planner than a confident invention. Do not propose a solution or a plan.

LANGUAGE: Write in the same language as the brief — Danish if it is in Danish,
otherwise English. Paths, symbols and commands stay as-is.`;

export interface RepoSurveyResult {
  /** The findings, or "" when no survey could be produced (planning then falls back to blind). */
  survey: string;
  tokensUsed: number;
}

export interface SurveyRepoOptions {
  model: BaseChatModel;
  repo: RepoTools;
  /** What the plan will be about — the mission goal, or the task. */
  brief: string;
  llmCallTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ground a planner in the actual repo before it plans: a bounded read-only ReAct
 * loop whose final message is a factual survey, which the caller injects into its
 * planning prompt. This is the fix for a planner that plans blind — it is the
 * difference between "add offset/limit to read_file" and a step that names the
 * three call sites and the check that proves it.
 *
 * BEST-EFFORT BY CONTRACT: any failure (timeout, no tool support, a provider
 * error) returns an empty survey rather than throwing. Planning blind is worse
 * than planning informed, but it is far better than a mission that cannot start
 * because the survey timed out — so the caller degrades instead of failing.
 */
export async function surveyRepo(options: SurveyRepoOptions): Promise<RepoSurveyResult> {
  const { model, repo, brief, signal } = options;
  const llmCallTimeoutMs = options.llmCallTimeoutMs ?? DEFAULT_LLM_CALL_TIMEOUT_MS;
  // A model without tool calling can't survey; fall back rather than throwing,
  // so a cheap tool-less planner model stays usable (just uninformed).
  if (typeof model.bindTools !== "function") return { survey: "", tokensUsed: 0 };

  let messages: BaseMessage[];
  try {
    const agent = createReactAgent({
      llm: model,
      tools: buildReadOnlyTools(repo),
      prompt: SYSTEM_PROMPT,
    });
    const result = (await withLlmTimeout(
      agent.invoke(
        { messages: [new HumanMessage(`# What is being planned\n${brief}`)] },
        { recursionLimit: RECURSION_LIMIT, signal },
      ),
      llmCallTimeoutMs * SURVEY_TIMEOUT_MULTIPLIER,
      "survey",
    )) as { messages: BaseMessage[] };
    messages = result.messages;
  } catch {
    return { survey: "", tokensUsed: 0 };
  }

  let tokensUsed = 0;
  let survey = "";
  for (const m of messages) {
    if (!isAIMessage(m)) continue;
    tokensUsed += m.usage_metadata?.total_tokens ?? 0;
    // The final tool-free assistant message is the report.
    if ((m.tool_calls ?? []).length === 0) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (text.trim()) survey = text.trim();
    }
  }
  return { survey, tokensUsed };
}
