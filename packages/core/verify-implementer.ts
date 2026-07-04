/**
 * Throwaway proof for the M2 implementer node (build-order Trin 3): a ReAct loop
 * on createReactAgent, driving the write tools to author + verify real code in a
 * worktree. Uses a scripted fake tool-calling model (no API key) so we can prove
 * the full path end-to-end: tool calls actually mutate disk, the final summary
 * becomes `draft`, tokens are summed, and a tool-call trace is produced. Also
 * proves the tool glue directly.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-implementer.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWritableRepoTools } from "../shared/src/repoTools.js";
import {
  buildImplementerTools,
  makeImplementerNode,
} from "./src/nodes/implementer.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

/** A BaseChatModel that replays a fixed list of AI messages — one per turn. */
class ScriptedToolModel extends BaseChatModel {
  private i = 0;
  constructor(private readonly steps: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted-tool";
  }
  override bindTools() {
    return this;
  }
  async _generate(_messages: unknown) {
    const msg = this.steps[Math.min(this.i, this.steps.length - 1)]!;
    this.i += 1;
    const text = typeof msg.content === "string" ? msg.content : "";
    return { generations: [{ text, message: msg }] };
  }
}

const baseState = (task: string): GraphStateType =>
  ({
    task,
    messages: [],
    draft: "",
    round: 0,
    verdict: null,
    status: "running",
    tokensUsed: 0,
    humanNotes: "",
    plan: [],
    currentStep: 0,
    stepResults: [],
    projectId: "",
    context: "",
    topology: "single",
  }) as GraphStateType;

const dir = await mkdtemp(join(tmpdir(), "verify-implementer-"));
try {
  // ── 1. tool glue: each tool calls through to the writable repo ──
  const repo = createWritableRepoTools(dir, { allowedCommands: ["node"] });
  const tools = Object.fromEntries(buildImplementerTools(repo).map((t) => [t.name, t]));
  ok(
    ["list_files", "read_file", "search_code", "write_file", "apply_edit", "delete_file", "run_command", "run_check"].every(
      (n) => n in tools,
    ),
    "buildImplementerTools exposes read + write tools",
  );
  await tools.write_file!.invoke({ path: "glue.ts", content: "export const g = 0;\n" });
  ok((await readFile(join(dir, "glue.ts"), "utf8")).includes("g = 0"), "write_file tool writes through to disk");
  await tools.apply_edit!.invoke({ path: "glue.ts", old_string: "g = 0", new_string: "g = 1" });
  ok((await readFile(join(dir, "glue.ts"), "utf8")).includes("g = 1"), "apply_edit tool edits through to disk");
  const ran = String(await tools.run_command!.invoke({ command: "node", args: ["-e", "process.exit(0)"] }));
  ok(ran.includes("exit code 0"), "run_command tool runs an allowlisted executable");
  await tools.delete_file!.invoke({ path: "glue.ts" });
  ok(!existsSync(join(dir, "glue.ts")), "delete_file tool deletes through to disk");

  // ── 2. end-to-end ReAct loop authors + verifies code, returns a draft ──
  const usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };
  const model = new ScriptedToolModel([
    new AIMessage({
      content: "",
      tool_calls: [{ name: "write_file", args: { path: "src/feature.ts", content: "export const n = 1;\n" }, id: "c1", type: "tool_call" }],
      usage_metadata: usage,
    }),
    new AIMessage({
      content: "",
      tool_calls: [{ name: "apply_edit", args: { path: "src/feature.ts", old_string: "n = 1", new_string: "n = 2" }, id: "c2", type: "tool_call" }],
      usage_metadata: usage,
    }),
    new AIMessage({
      content: "",
      tool_calls: [{ name: "run_command", args: { command: "node", args: ["-e", "process.exit(0)"] }, id: "c3", type: "tool_call" }],
      usage_metadata: usage,
    }),
    new AIMessage({ content: "Implementeret: skrev src/feature.ts (n=2) og kørte node-tjek.", usage_metadata: usage }),
  ]);

  const node = makeImplementerNode(model as unknown as BaseChatModel, repo);
  const out = await node(baseState("Tilføj en feature-konstant i src/feature.ts"));

  ok((await readFile(join(dir, "src/feature.ts"), "utf8")).includes("n = 2"), "the loop wrote AND edited a real file on disk");
  ok(out.draft === "Implementeret: skrev src/feature.ts (n=2) og kørte node-tjek.", "final summary becomes the draft");
  ok(out.tokensUsed === 40, "tokens are summed across every model turn (4×10)");
  ok(out.round === 1, "round advances");
  const trace = (out.messages ?? []).filter((m) => m.content.startsWith("🔧"));
  ok(trace.length === 3, "every tool call is recorded in the trace");
  ok(trace.some((m) => m.content.includes("write_file")) && trace.some((m) => m.content.includes("apply_edit")), "trace names the tools that were called");
  ok((out.messages ?? []).every((m) => m.agent === "implementer"), "messages are attributed to the implementer");

  // ── 3. injected extra tools (M4: MCP, e.g. a daisyUI blueprint) join the belt ──
  {
    // A stand-in for an MCP tool — the implementer must be able to CALL it, then
    // write the returned markup to disk (the daisyUI-blueprint use case).
    let snippetCalls = 0;
    const daisyTool = tool(
      async ({ component }: { component: string }) => {
        snippetCalls += 1;
        return `<button class="btn btn-primary">${component}</button>`;
      },
      {
        name: "daisyui_snippet",
        description: "Return the on-brand daisyUI markup for a component.",
        schema: z.object({ component: z.string() }),
      },
    );

    // It's present in the assembled belt...
    const belt = buildImplementerTools(repo);
    const withExtra = [...belt, daisyTool];
    ok(
      withExtra.some((t) => t.name === "daisyui_snippet") && withExtra.length === belt.length + 1,
      "an injected extra tool is appended to the implementer belt (never replaces the file tools)",
    );

    // ...and the implementer actually calls it, then writes what it returned.
    const uiModel = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "daisyui_snippet", args: { component: "Køb" }, id: "d1", type: "tool_call" }],
        usage_metadata: usage,
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "write_file",
            args: { path: "src/Button.tsx", content: `<button class="btn btn-primary">Køb</button>` },
            id: "d2",
            type: "tool_call",
          },
        ],
        usage_metadata: usage,
      }),
      new AIMessage({ content: "Byggede Button.tsx med daisyUI-markup fra blueprintet.", usage_metadata: usage }),
    ]);
    const uiNode = makeImplementerNode(uiModel as unknown as BaseChatModel, repo, [daisyTool]);
    const uiOut = await uiNode(baseState("Byg en køb-knap med daisyUI"));
    ok(snippetCalls === 1, "the implementer CALLED the injected MCP tool mid-loop");
    ok(
      (await readFile(join(dir, "src/Button.tsx"), "utf8")).includes("btn btn-primary"),
      "the tool's returned markup was written to disk",
    );
    ok(
      (uiOut.messages ?? []).some((m) => m.content.includes("daisyui_snippet")),
      "the MCP tool call is recorded in the trace",
    );
  }

  console.log("\nM2 implementer node (+ injected MCP tools) verified ✓");
} finally {
  await rm(dir, { recursive: true, force: true });
}
