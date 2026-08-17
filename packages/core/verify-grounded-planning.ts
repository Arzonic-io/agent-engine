/**
 * Proof for grounded planning — the Architect and the Decomposer plan against the
 * REAL repo, and the plan they emit is a handoff a cheaper executor can act on
 * without re-deriving it. Scripted fake models, no LLM, no DB.
 *
 * Proves: the planners survey before planning and inject what they found; a
 * survey failure degrades to blind planning instead of failing the run; the
 * planner cannot write (read-only by type); a step's spec reaches the worker
 * while the plan overview stays titles-only; a pre-structured `string[]`
 * checkpoint still resumes; and a blind decomposition produces exactly the old
 * `detail` shape.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-grounded-planning.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { makeArchitectNode } from "./src/nodes/architect.js";
import { applyDecomposeGuards, type DecomposeOutput } from "./src/nodes/decompose.js";
import { buildReadOnlyTools, surveyRepo } from "./src/nodes/repoSurvey.js";
import { makeWorkerNode } from "./src/nodes/worker.js";
import { formatPlanStep, toPlanStep, type GraphStateType, type PlanStep } from "./src/state.js";
import type { RepoTools } from "./src/tools.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const state = (over: Partial<GraphStateType> = {}): GraphStateType =>
  ({
    task: "Add offset/limit to read_file",
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
    topology: "team",
    forcedTopology: null,
    extraCriteria: [],
    ...over,
  }) as GraphStateType;

/** A repo whose reads are recorded, so we can prove the planner actually looked. */
function fakeRepo(): RepoTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listFiles(dir) {
      calls.push(`listFiles:${dir}`);
      return "repoTools.ts\ntools.ts";
    },
    async readFile(path, options) {
      calls.push(`readFile:${path}:${options?.offset ?? ""}:${options?.limit ?? ""}`);
      return "1→export function readFile() {}";
    },
    async searchCode(query) {
      calls.push(`searchCode:${query}`);
      return "packages/shared/src/repoTools.ts:100: async readFile(path)";
    },
    async runCheck(name) {
      calls.push(`runCheck:${name}`);
      return `$ pnpm run ${name}\n(exit 0)`;
    },
  };
}

/**
 * A BaseChatModel that replays a scripted sequence of tool-calling turns and then
 * a final text turn — enough for createReactAgent to drive a real loop. Same
 * shape as verify-implementer's ScriptedToolModel (createReactAgent rejects a
 * plain object, even one with bindTools).
 */
class ScriptedToolModel extends BaseChatModel {
  private i = 0;
  constructor(
    private readonly toolTurns: Array<{ name: string; args: Record<string, unknown> }>,
    private readonly final: string,
  ) {
    super({});
  }
  _llmType() {
    return "scripted-tool";
  }
  override bindTools() {
    return this;
  }
  async _generate(_messages: unknown) {
    const t = this.toolTurns[this.i];
    this.i += 1;
    const usage_metadata = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };
    const message = t
      ? new AIMessage({
          content: "",
          tool_calls: [{ id: `call-${this.i}`, name: t.name, args: t.args }],
          usage_metadata,
        })
      : new AIMessage({ content: this.final, usage_metadata });
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

/** Captures the prompt handed to withStructuredOutput and returns a scripted plan. */
function scriptedPlanModel(
  plan: PlanStep[],
  toolTurns: Array<{ name: string; args: unknown }> = [],
  survey = "SURVEY: read_file lives in packages/shared/src/repoTools.ts:100; `typecheck` passes.",
) {
  const model = new ScriptedToolModel(
    toolTurns as Array<{ name: string; args: Record<string, unknown> }>,
    survey,
  ) as ScriptedToolModel & Record<string, unknown>;
  const seen: { system: string; human: string }[] = [];
  model.withStructuredOutput = () => ({
    async invoke(messages: BaseMessage[]) {
      seen.push({
        system: String(messages[0]!.content),
        human: String(messages[1]!.content),
      });
      return {
        raw: new AIMessage({
          content: "",
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 7 },
        }),
        parsed: { plan },
      };
    },
  });
  return { model, seen };
}

async function main() {
  // ── 1. The Architect surveys before planning, and plans against what it found ──
  {
    const repo = fakeRepo();
    const { model, seen } = scriptedPlanModel(
      [{ title: "Add offset/limit", files: ["packages/shared/src/repoTools.ts"], verify: "typecheck" }],
      [
        { name: "search_code", args: { query: "readFile" } },
        { name: "read_file", args: { path: "packages/shared/src/repoTools.ts", offset: 90, limit: 40 } },
      ],
    );
    const out = await makeArchitectNode(model, { repo })(state());

    ok(repo.calls.some((c) => c.startsWith("searchCode:")), "architect actually searched the repo before planning");
    ok(
      repo.calls.includes("readFile:packages/shared/src/repoTools.ts:90:40"),
      "architect paged to the relevant window instead of pulling the whole file",
    );
    ok(seen[0]!.human.includes("SURVEY:"), "the survey is injected into the planning prompt");
    ok(seen[0]!.system.includes("HANDOFF"), "the grounded prompt tells it the plan is a handoff");
    ok(out.tokensUsed === 10 * 3 + 7, "survey tokens fold into the run's spend (3 survey turns + plan)");
    ok(
      String(out.messages![0]!.content).includes("Files: packages/shared/src/repoTools.ts"),
      "the transcript shows the spec, not just the title",
    );
  }

  // ── 2. No repo ⇒ the old blind behaviour, unchanged ──
  {
    const { model, seen } = scriptedPlanModel([{ title: "Write the intro", files: [] }]);
    const out = await makeArchitectNode(model, {})(state({ task: "Write a blog post" }));
    ok(!seen[0]!.system.includes("HANDOFF"), "without a repo the grounded prompt is not applied");
    ok(!seen[0]!.human.includes("Survey"), "without a repo no survey section is added");
    ok(out.tokensUsed === 7, "without a repo no survey tokens are spent");
  }

  // ── 3. A failed survey degrades to blind planning, it does not fail the run ──
  {
    const exploding: any = {
      _llmType: () => "fake",
      bindTools() {
        throw new Error("provider exploded");
      },
    };
    const r = await surveyRepo({ model: exploding, repo: fakeRepo(), brief: "x" });
    ok(r.survey === "" && r.tokensUsed === 0, "a throwing survey returns empty rather than propagating");

    const toolless: any = { _llmType: () => "fake" };
    const r2 = await surveyRepo({ model: toolless, repo: fakeRepo(), brief: "x" });
    ok(r2.survey === "", "a model without tool calling degrades instead of throwing");
  }

  // ── 4. The planner's belt is read-only BY TYPE, not by instruction ──
  {
    const names = buildReadOnlyTools(fakeRepo()).map((t) => t.name).sort();
    ok(
      names.join(",") === "list_files,read_file,run_check,search_code",
      "the survey belt exposes exactly the four read tools",
    );
    ok(
      !names.some((n) => ["write_file", "apply_edit", "delete_file", "run_command"].includes(n)),
      "no write or arbitrary-command tool can leak into a planner",
    );
  }

  // ── 5. The worker gets its OWN step's spec; the overview stays titles-only ──
  {
    const plan: PlanStep[] = [
      { title: "Add offset/limit", files: ["repoTools.ts"], change: "line window", verify: "typecheck", done: "paging works" },
      { title: "Update call sites", files: ["implementer.ts"], change: "pass through" },
    ];
    let prompt = "";
    const worker: any = {
      _llmType: () => "fake",
      async invoke(messages: BaseMessage[]) {
        prompt = String(messages[1]!.content);
        return new AIMessage({ content: "done", usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      },
    };
    const out = await makeWorkerNode(worker)(state({ plan, currentStep: 0 }));
    ok(prompt.includes("Change: line window"), "the worker's own step carries the full spec");
    ok(prompt.includes("Done when: paging works"), "including the done-condition");
    ok(
      prompt.includes("2. Update call sites") && !prompt.includes("pass through"),
      "the plan overview lists titles only — no spec for steps this worker must not do",
    );
    ok(out.stepResults![0]!.step === "Add offset/limit", "stepResults keeps a plain string label for the lead");
  }

  // ── 6. Resume: a pre-structured `string[]` checkpoint still runs ──
  {
    ok(
      JSON.stringify(toPlanStep("old style step")) === JSON.stringify({ title: "old style step", files: [] }),
      "a legacy string step coerces to a PlanStep",
    );
    ok(formatPlanStep("bare") === "bare", "a spec-less step renders as its bare title");

    let prompt = "";
    const worker: any = {
      _llmType: () => "fake",
      async invoke(messages: BaseMessage[]) {
        prompt = String(messages[1]!.content);
        return new AIMessage({ content: "done", usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      },
    };
    // Exactly what LangGraph rehydrates from a checkpoint written before the change.
    const legacy = state({ plan: ["step one", "step two"] as unknown as PlanStep[], currentStep: 1 });
    const out = await makeWorkerNode(worker)(legacy);
    ok(prompt.includes("# Your step (2/2)\nstep two"), "a legacy string[] plan resumes without crashing");
    ok(out.stepResults![0]!.step === "step two", "and records the right step label");
  }

  // ── 7. Decomposer: specifics fold into `detail`; blind output is unchanged ──
  {
    const grounded: DecomposeOutput = {
      items: [
        {
          key: "paging",
          title: "Add offset/limit to read_file",
          detail: "Return a bounded line window.",
          files: ["packages/shared/src/repoTools.ts", " packages/core/src/tools.ts "],
          verify: "typecheck",
          dependsOn: [],
        },
      ],
    };
    const g = applyDecomposeGuards(grounded, 0);
    ok(
      g.items[0]!.detail ===
        "Return a bounded line window.\nFiles: packages/shared/src/repoTools.ts, packages/core/src/tools.ts\nVerify: typecheck",
      "files + verify fold into detail (trimmed) — no backlog migration needed",
    );

    const blind: DecomposeOutput = {
      items: [{ key: "a", title: "Do the thing", detail: "Some specifics.", files: [], dependsOn: [] }],
    };
    ok(
      applyDecomposeGuards(blind, 0).items[0]!.detail === "Some specifics.",
      "a blind decomposition yields exactly the old detail shape — no empty headings",
    );
    ok(
      applyDecomposeGuards(
        { items: [{ key: "a", title: "T", files: [], dependsOn: [] }] },
        0,
      ).items[0]!.detail === undefined,
      "an item with no specifics still has no detail at all",
    );
  }

  console.log("\nGrounded planning (architect + decomposer survey the repo) verified ✓");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
