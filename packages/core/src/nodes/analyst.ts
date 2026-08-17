import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentMessage, GraphStateType } from "../state.js";
import type { RepoTools } from "../tools.js";

/** Hard cap on tool round-trips per analyst turn — keeps the ReAct loop provably terminating. */
const MAX_TOOL_STEPS = 24;

const SYSTEM_PROMPT = `You are the Analyst, a code investigator working on a repository.
You have tools to explore and verify:
- list_files, read_file, search_code — read the repo. GROUND every claim; never
  guess about code you have not actually read.
- run_check — run an allowlisted verification command (e.g. test, lint,
  typecheck, build) and read its real output. Use it to CONFIRM suspicions
  instead of speculating: if you think something is broken, run the check and
  cite the actual error.

Start broad (list the root, read package.json / README), drill into the relevant
areas, and run checks where they strengthen a finding. When you have enough
evidence, STOP calling tools and write a final report: concrete, specific,
actionable findings, each citing the file (and line / command output where
possible). No vague advice. If critic feedback is provided, dig deeper with the
tools to address it rather than repeating yourself.

LANGUAGE: Write your final report in the same language as the task — Danish if
the task is in Danish, otherwise English. Use only Danish or English. (Tool
calls and code citations stay as-is.)`;

function buildPrompt(state: GraphStateType): string {
  const parts = [`# Task\n${state.task}`];
  if (state.draft) parts.push(`# Your previous report\n${state.draft}`);
  if (state.verdict && state.verdict.issues.length > 0) {
    parts.push(
      `# Critic issues to address (investigate further with tools)\n${state.verdict.issues
        .map((i) => `- ${i}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

const preview = (s: string, n = 140) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

/**
 * ReAct-style worker: binds the injected RepoTools to the model and loops
 * (model → tool calls → observations → model) until the model stops requesting
 * tools or the step cap is hit, then returns the final report as `draft`.
 */
export function makeAnalystNode(model: BaseChatModel, repo: RepoTools) {
  const tools: StructuredToolInterface[] = [
    tool(async ({ dir }: { dir?: string }) => repo.listFiles(dir ?? "."), {
      name: "list_files",
      description:
        "List files and folders in a directory (relative to the repo root). Folders end with '/'. Use '.' for the root.",
      schema: z.object({
        dir: z.string().optional().describe("Directory relative to repo root; defaults to '.'"),
      }),
    }),
    tool(
      async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) =>
        repo.readFile(path, { offset, limit }),
      {
        name: "read_file",
        description:
          "Read a UTF-8 text file relative to the repo root. Returns lines prefixed 'N→' (the " +
          "prefixes are display only, not file content); reads a window from the start by default " +
          "and tells you the offset to continue from. Pass offset/limit to read the part you need " +
          "of a large file instead of all of it.",
        schema: z.object({
          path: z.string().describe("File path relative to repo root"),
          offset: z.number().int().min(1).optional().describe("1-based first line to read; defaults to 1"),
          limit: z.number().int().min(1).optional().describe("Maximum lines to return; defaults to a few hundred"),
        }),
      },
    ),
    tool(async ({ query }: { query: string }) => repo.searchCode(query), {
      name: "search_code",
      description:
        "Case-insensitive substring search across the repo. Returns matching 'path:line: text' hits.",
      schema: z.object({ query: z.string().describe("Substring to search for") }),
    }),
    tool(async ({ name }: { name: string }) => repo.runCheck(name), {
      name: "run_check",
      description:
        "Run an allowlisted verification command in the repo (e.g. test, lint, typecheck, build) and read its output + exit status. Use to confirm findings against reality.",
      schema: z.object({
        name: z
          .string()
          .describe("Check to run, e.g. 'test', 'lint', 'typecheck', 'build'"),
      }),
    }),
  ];

  const toolsByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t]),
  );

  if (typeof model.bindTools !== "function") {
    throw new Error("The configured LLM does not support tool calling (bindTools).");
  }
  const modelWithTools = model.bindTools(tools);

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const messages: BaseMessage[] = [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildPrompt(state)),
    ];
    const trace: AgentMessage[] = [];
    let tokens = 0;
    let report = "";

    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const ai = await modelWithTools.invoke(messages);
      tokens += ai.usage_metadata?.total_tokens ?? 0;
      messages.push(ai);

      const calls = ai.tool_calls ?? [];
      if (calls.length === 0) {
        report =
          typeof ai.content === "string" ? ai.content : JSON.stringify(ai.content);
        break;
      }

      for (const call of calls) {
        const t = call.name ? toolsByName.get(call.name) : undefined;
        let result: string;
        try {
          result = t
            ? String(await t.invoke(call.args as Record<string, unknown>))
            : `Unknown tool: ${call.name}`;
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
        const argStr = preview(JSON.stringify(call.args), 60);
        trace.push({
          agent: "analyst",
          role: "assistant",
          content: `🔧 ${call.name}(${argStr}) → ${preview(result)}`,
        });
        messages.push(
          new ToolMessage({ content: result, tool_call_id: call.id ?? call.name ?? "tool" }),
        );
      }
    }

    if (!report) {
      report = `Analyst reached the ${MAX_TOOL_STEPS}-step tool limit before concluding. Partial findings may be incomplete.`;
    }

    return {
      draft: report,
      round: state.round + 1,
      tokensUsed: state.tokensUsed + tokens,
      status: "running",
      messages: [...trace, { agent: "analyst", role: "assistant", content: report }],
    };
  };
}
