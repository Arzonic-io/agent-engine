/**
 * Proof that the planner's per-item check can no longer make an item red by
 * construction. The Verifier runs a check only when its NAME is exactly on the
 * allowlist (`pnpm run <name>`), but the decomposer took `verify` as free text —
 * so a plan that said "pnpm test" failed every attempt on "not allowed", burned
 * MISSION_THRASH_LIMIT implementer loops, and parked an item whose code was fine.
 *
 * Wires the REAL decomposer (its reply parsed by LangChain's real structured-output
 * pipeline, the one ChatMistralAI uses), the real controller and the real Verifier
 * running real `pnpm run` checks in a temp package. Only the model's reply, the
 * implementer and the replan judgement are scripted. No LLM, no DB, no network.
 *
 * Proves: a correct item planned with "pnpm test" is done in one attempt; the model
 * is offered exactly the runnable checks (or "none") as an enum; a check spelled
 * like a command is normalized and an unknown one dropped with a warning — never a
 * failed plan; and an item's check still only ever ADDS to the mission's checks.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-item-check.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  assembleStructuredOutputPipeline,
  createFunctionCallingParser,
} from "@langchain/core/language_models/structured_output";
import { AIMessage } from "@langchain/core/messages";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier } from "../shared/src/verifier.js";
import { runMission, type Replanner } from "./src/controller.js";
import { makeDecomposer } from "./src/nodes/decompose.js";
import { applyReplanGuards } from "./src/nodes/replan.js";
import type {
  BacklogItem,
  BacklogStore,
  CreateBacklogItemInput,
  Mission,
} from "./src/mission.js";
import type { WorkRunner } from "./src/runner.js";
import type { Verifier } from "./src/verifier.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

/** The production defaults: REPO_ALLOWED_CHECKS and MISSION_CHECKS. */
const ALLOWED = ["test", "lint", "typecheck", "build"];
const MISSION_CHECKS = ["typecheck", "test"];

let seq = 0;
const iso = () => new Date(1_700_000_000_000 + seq++ * 1000).toISOString();

const mission: Mission = {
  id: "m1",
  projectId: "p1",
  goal: "Add a sum helper",
  acceptanceCriteria: ["sum(2, 3) is 5"],
  repoPath: "/tmp/unused",
  checks: [],
  status: "running",
  budget: null,
  spentTokens: 0,
  deadline: null,
  roleModels: {},
  guidance: null,
  iterations: 0,
  noProgress: 0,
  stopReason: null,
  prUrl: null,
  publishNote: null,
  issueNumber: null,
  createdAt: iso(),
};

/** In-memory store whose createItem persists `verify` like the real one does. */
function makeStore(m: Mission): BacklogStore {
  const missions = new Map([[m.id, { ...m }]]);
  const items = new Map<string, BacklogItem>();
  return {
    async createMission() {
      throw new Error("unused");
    },
    async getMission(id) {
      const found = missions.get(id);
      return found ? { ...found } : null;
    },
    async listMissions() {
      return [...missions.values()];
    },
    async updateMission(id, patch) {
      const found = missions.get(id);
      if (!found) return null;
      Object.assign(found, patch);
      return { ...found };
    },
    async deleteMission(id) {
      missions.delete(id);
    },
    async createItem(input: CreateBacklogItemInput) {
      const it: BacklogItem = {
        id: `item-${seq++}`,
        missionId: input.missionId,
        title: input.title,
        detail: input.detail ?? "",
        verify: input.verify ?? "",
        status: "todo",
        priority: input.priority ?? 0,
        dependsOn: input.dependsOn ?? [],
        risk: input.risk ?? "low",
        runId: null,
        verification: null,
        diff: null,
        createdAt: iso(),
        updatedAt: iso(),
      };
      items.set(it.id, it);
      return { ...it };
    },
    async getItem(id) {
      const i = items.get(id);
      return i ? { ...i } : null;
    },
    async listItems() {
      return [...items.values()].sort(
        (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      );
    },
    async updateItem(id, patch) {
      const i = items.get(id);
      if (!i) return null;
      Object.assign(i, patch, { updatedAt: iso() });
      return { ...i };
    },
    async nextActionable(missionId) {
      const next = [...items.values()]
        .filter((i) => i.missionId === missionId && i.status === "todo")
        .filter((i) => i.dependsOn.every((d) => items.get(d)?.status === "done"))
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      return next[0] ? { ...next[0] } : null;
    },
  };
}

/**
 * A chat model whose `withStructuredOutput` is ChatMistralAI's, minus the network:
 * the reply is a tool call, parsed by `createFunctionCallingParser` (zod-validated)
 * inside `assembleStructuredOutputPipeline` — where a schema mismatch becomes
 * `parsed: null`. Records the JSON schema a provider would put on the wire.
 */
function scriptedPlanner(items: Array<Record<string, unknown>>) {
  const sent: { schema?: any } = {};
  let toolName = "extract";
  class Planner extends BaseChatModel {
    _llmType() {
      return "scripted-planner";
    }
    async _generate() {
      const message = new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: toolName, args: { items, reasoning: "scripted" } }],
        usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      });
      return { generations: [{ text: "", message }] };
    }
  }
  const model = new Planner({}) as Planner & Record<string, unknown>;
  model.withStructuredOutput = (schema: any, config?: { name?: string; includeRaw?: boolean }) => {
    sent.schema = toJsonSchema(schema);
    toolName = config?.name ?? toolName;
    return assembleStructuredOutputPipeline(
      model,
      createFunctionCallingParser(schema, toolName),
      config?.includeRaw,
    );
  };
  return { model, sent };
}

/** Collect console.warn output while `fn` runs, so drops are asserted, not printed. */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const accepting = (): WorkRunner & { runs: number } => {
  const runner = {
    runs: 0,
    async run(it: { id: string }) {
      runner.runs++;
      return { runId: `run-${it.id}-${runner.runs}`, status: "accepted" as const, draft: "built", verdict: null, tokensUsed: 100 };
    },
  };
  return runner;
};

/** The production replan guard over a model that (correctly) judges the code done:
 *  "done" only survives when the Verifier passed, otherwise the item stays open. */
const judgesDone: Replanner = {
  async replan({ verification }) {
    return applyReplanGuards(
      { itemStatus: "done", reasoning: "the code is correct", followUps: [] },
      verification,
      0,
    );
  },
};

const fixture = await mkdtemp(join(tmpdir(), "verify-item-check-"));
try {
  // Correct code: every allowlisted check passes.
  const pass = 'node -e "process.exit(0)"';
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "item-check-fixture",
      private: true,
      scripts: { test: pass, lint: pass, typecheck: pass, build: pass },
    }),
  );
  const realVerifier = createVerifier(fixture, { allowedChecks: ALLOWED });
  /** The real Verifier, recording which checks the controller asked it to run. */
  const recording = (): Verifier & { asked: string[][] } => {
    const v = {
      asked: [] as string[][],
      run(checks: string[], cwd?: string) {
        v.asked.push([...checks]);
        return realVerifier.run(checks, cwd);
      },
    };
    return v;
  };

  // ── 1. The reproduction: a correct item planned with verify:"pnpm test" ──
  {
    const { model } = scriptedPlanner([
      { key: "sum", title: "Add a sum helper", files: ["src/sum.js"], verify: "pnpm test" },
    ]);
    const store = makeStore(mission);
    const runner = accepting();
    const verifier = recording();
    const out = await runMission(
      {
        backlog: store,
        verifier,
        runner,
        replanner: judgesDone,
        decomposer: makeDecomposer(model, { allowedChecks: ALLOWED }),
        checks: MISSION_CHECKS,
      },
      mission.id,
    );
    const [item] = await store.listItems(mission.id);
    ok(
      out.status === "done" && out.itemsDone === 1 && item?.status === "done",
      `a correct item planned with verify:"pnpm test" is done, not parked (got ${out.status}/${out.reason}, item ${item?.status})`,
    );
    ok(runner.runs === 1, `one implementer loop, not MISSION_THRASH_LIMIT of them (got ${runner.runs})`);
    ok(
      JSON.stringify(verifier.asked) === '[["typecheck","test"]]',
      `the Verifier ran the check the planner meant — "test", once (got ${JSON.stringify(verifier.asked)})`,
    );
  }

  // ── 2. The model is offered a typed choice: the runnable checks, or "none" ──
  {
    const { model, sent } = scriptedPlanner([{ key: "a", title: "Add a sum helper", verify: "test" }]);
    await makeDecomposer(model, { allowedChecks: ALLOWED }).decompose({ mission });
    const verify = sent.schema?.properties?.items?.items?.properties?.verify;
    ok(
      verify?.type === "string" &&
        JSON.stringify([...(verify.enum ?? [])].sort()) === '["build","lint","none","test","typecheck"]',
      `the schema on the wire offers exactly the allowlisted checks plus "none" (got ${JSON.stringify(verify)})`,
    );

    const blanks = scriptedPlanner([{ key: "a", title: "Add a sum helper" }]);
    await makeDecomposer(blanks.model, { allowedChecks: ["test", " ", "test", ""] }).decompose({ mission });
    const offered = blanks.sent.schema?.properties?.items?.items?.properties?.verify?.enum;
    ok(
      JSON.stringify([...(offered ?? [])].sort()) === '["none","test"]',
      `blank and duplicate allowlist entries never reach the enum — Gemini rejects "" (got ${JSON.stringify(offered)})`,
    );
  }

  // ── 3. Off-list replies survive the real parse: normalized, or dropped with a warning ──
  {
    const { model } = scriptedPlanner([
      { key: "a", title: "A", verify: "pnpm test" },
      { key: "b", title: "B", verify: "pnpm run lint" },
      { key: "c", title: "C", verify: "npm run typecheck" },
      { key: "d", title: "D", verify: "build" },
      { key: "e", title: "E", verify: "none" },
      { key: "f", title: "F", verify: "vitest run src/sum.test.ts" },
      { key: "g", title: "G", verify: "pnpm test -- src/sum.test.ts" },
    ]);
    let threw: unknown = null;
    let plan: Awaited<ReturnType<ReturnType<typeof makeDecomposer>["decompose"]>> | null = null;
    let warnings: string[] = [];
    try {
      const captured = await capturingWarnings(() =>
        makeDecomposer(model, { allowedChecks: ALLOWED }).decompose({ mission }),
      );
      plan = captured.value;
      warnings = captured.warnings;
    } catch (err) {
      threw = err;
    }
    ok(!threw, `an off-list check name never fails the whole plan (threw: ${String(threw)})`);
    const verifies = plan!.items.map((i) => i.verify ?? null);
    ok(
      JSON.stringify(verifies) === '["test","lint","typecheck","build",null,null,null]',
      `command spellings normalize to the script name; "none" and unknown names leave no item check (got ${JSON.stringify(verifies)})`,
    );
    ok(
      warnings.length === 2 &&
        warnings[0]!.includes("vitest run src/sum.test.ts") &&
        warnings[1]!.includes("pnpm test -- src/sum.test.ts"),
      `each dropped check is logged with what was dropped, and nothing else is (got ${JSON.stringify(warnings)})`,
    );
    const details = plan!.items.map((i) => i.detail ?? null);
    ok(
      JSON.stringify(details) ===
        '["Verify: test","Verify: lint","Verify: typecheck","Verify: build",null,null,null]',
      `the implementer is told the same check the gate runs — never a dropped one (got ${JSON.stringify(details)})`,
    );
  }

  // ── 4. An item's check only ever ADDS to the mission's checks ──
  {
    const { model } = scriptedPlanner([
      { key: "lint", title: "Tidy the sum helper", verify: "lint" },
      { key: "dup", title: "Cover the sum helper", verify: "pnpm run test" },
      { key: "bad", title: "Document the sum helper", verify: "vitest run src/sum.test.ts" },
    ]);
    const store = makeStore(mission);
    const verifier = recording();
    const { value: out, warnings } = await capturingWarnings(() =>
      runMission(
        {
          backlog: store,
          verifier,
          runner: accepting(),
          replanner: judgesDone,
          decomposer: makeDecomposer(model, { allowedChecks: ALLOWED }),
          checks: MISSION_CHECKS,
        },
        mission.id,
      ),
    );
    ok(out.status === "done" && out.itemsDone === 3, `all three items verified done (got ${out.status}, ${out.itemsDone})`);
    ok(
      JSON.stringify(verifier.asked) ===
        '[["lint","typecheck","test"],["typecheck","test"],["typecheck","test"]]',
      `own check first, a mission check never twice, a dropped check never in its place (got ${JSON.stringify(verifier.asked)})`,
    );
    ok(
      verifier.asked.every((ran) => MISSION_CHECKS.every((c) => ran.includes(c))),
      "every item still ran every mission check — an item can never narrow its gate",
    );
    ok(warnings.length === 1, `the dropped check was logged once (got ${JSON.stringify(warnings)})`);
  }

  console.log("\nPer-item checks are a typed, runnable choice ✓");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
