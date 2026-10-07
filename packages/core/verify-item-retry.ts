/**
 * Throwaway proof that a RETRIED mission item starts a fresh attempt. Every
 * attempt of an item runs under the same thread_id (= item id) on a shared
 * checkpointer, so a retry must not inherit the previous attempt's per-attempt
 * channels: `tokensUsed` would still hold the earlier attempts' spend (which the
 * controller then adds to spent_tokens AGAIN, tripping the budget early), and
 * `round` would carry over, ending the critic → implementer revision loop after
 * the first review. Drives the real mission team graph through the worktree
 * runner — a FRESH graph per attempt over ONE MemorySaver, exactly as the worker
 * compiles it over the shared Postgres saver — with a scripted fake model and an
 * in-memory repo (no API key, no git, no DB). Also proves what deliberately
 * survives: the worktree is reused as-is, so the retry's implementer still reads
 * the previous attempt's summary and last critic issues.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-item-retry.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { runMission, type Replanner } from "./src/controller.js";
import { createMissionTeamGraph } from "./src/graph.js";
import type { BacklogItem, BacklogStore, Mission } from "./src/mission.js";
import { createWorktreeWorkRunner, type RunnableMissionGraph } from "./src/runner.js";
import { billableTokens } from "./src/tokens.js";
import type { WritableRepoTools } from "./src/tools.js";
import type { Verifier } from "./src/verifier.js";
import type { WorktreeManager } from "./src/worktree.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };

/**
 * Scripted model for the mission team. Each implementer pass gets one write_file
 * call and then a final summary; each critic review gets the next scripted
 * verdict. It counts passes, reviews and the tokens it billed, so every attempt
 * can be checked against what was actually spent.
 */
class FakeTeamModel extends BaseChatModel {
  passes = 0;
  reviews = 0;
  billed = 0;
  /** The implementer's prompt at the start of each pass — what history it was given. */
  prompts: string[] = [];
  constructor(private readonly verdicts: { pass: boolean; issues: string[] }[]) {
    super({});
  }
  _llmType() {
    return "fake-team";
  }
  override bindTools() {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override withStructuredOutput(): any {
    return {
      invoke: async () => {
        const v = this.verdicts[Math.min(this.reviews, this.verdicts.length - 1)]!;
        this.reviews += 1;
        this.billed += billableTokens(usage);
        return { raw: new AIMessage({ content: "", usage_metadata: usage }), parsed: v };
      },
    };
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    let msg: AIMessage;
    if (HumanMessage.isInstance(last)) {
      // A new implementer pass opens on its task prompt.
      this.passes += 1;
      this.prompts.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
      msg = new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "write_file",
            args: { path: "src/answer.ts", content: `export const pass = ${this.passes};\n` },
            id: `w${this.passes}`,
            type: "tool_call",
          },
        ],
        usage_metadata: usage,
      });
    } else {
      msg = new AIMessage({ content: `summary of pass ${this.passes}`, usage_metadata: usage });
    }
    this.billed += billableTokens(usage);
    return { generations: [{ text: typeof msg.content === "string" ? msg.content : "", message: msg }] };
  }
}

/** Two reviews per attempt (reviewRounds 1): attempt 1 ends red, the retry's revision passes. */
const verdicts = [
  { pass: false, issues: ["issue from review 1"] }, // attempt 1, first pass
  { pass: false, issues: ["issue from review 2"] }, // attempt 1, revision — still red
  { pass: false, issues: ["issue from review 3"] }, // retry, first pass
  { pass: true, issues: [] }, // retry, revision — approved
];
/** What one full attempt bills: two passes (call + summary each) and two reviews. */
const ATTEMPT_TOKENS = (2 * 2 + 2) * billableTokens(usage);

/** The item's worktree, in memory. One per item and reused across attempts, like the real one. */
function makeRepo(): WritableRepoTools {
  const files = new Map<string, string>();
  return {
    async listFiles() {
      return [...files.keys()].join("\n");
    },
    async readFile(path) {
      return files.get(path) ?? `(no such file: ${path})`;
    },
    async searchCode() {
      return "";
    },
    async runCheck(name) {
      return `${name}: ok`;
    },
    async writeFile(path, content) {
      files.set(path, content);
      return `wrote ${path}`;
    },
    async applyEdit(path) {
      return `edited ${path}`;
    },
    async deleteFile(path) {
      files.delete(path);
      return `deleted ${path}`;
    },
    // The critic's `git add -N` + `git diff`: show what the worktree holds.
    async runCommand(_command, args = []) {
      return args.includes("diff") ? [...files].map(([p, c]) => `+++ b/${p}\n+${c}`).join("\n") : "";
    },
  };
}

/** Like the real manager on resume: the same id gets the same worktree back. */
const worktrees: WorktreeManager = {
  async create({ id, branch }) {
    return { id, path: `/worktrees/${id}`, branch };
  },
  async remove() {},
  async list() {
    return [];
  },
  async prune() {},
};

/** The worker's wiring in miniature: a fresh graph per attempt, ONE shared checkpointer. */
function makeRunner(model: FakeTeamModel) {
  const saver = new MemorySaver();
  const repo = makeRepo();
  return createWorktreeWorkRunner({
    worktrees,
    branch: (it) => `mission/m1/item/${it.id}`,
    buildGraph: () =>
      createMissionTeamGraph({
        model: model as unknown as BaseChatModel,
        repo,
        checkpointer: saver,
        reviewRounds: 1,
      }) as RunnableMissionGraph,
  });
}

// ── 1. the same item, run twice: each attempt is a fresh attempt ──
{
  const model = new FakeTeamModel(verdicts);
  const runner = makeRunner(model);
  const item = { id: "item-1", title: "Set answer = 42 in src/answer.ts" };

  const attempt = async (label: string) => {
    const before = { passes: model.passes, reviews: model.reviews, billed: model.billed, prompts: model.prompts.length };
    const result = await runner.run(item);
    const a = {
      result,
      passes: model.passes - before.passes,
      reviews: model.reviews - before.reviews,
      billed: model.billed - before.billed,
      firstPrompt: model.prompts[before.prompts] ?? "",
    };
    console.log(
      `${label}: ${a.passes} implementer passes, ${a.reviews} reviews, billed ${a.billed}, reported tokensUsed ${result.tokensUsed}`,
    );
    return a;
  };

  const first = await attempt("attempt 1");
  ok(first.passes === 2 && first.reviews === 2, "attempt 1: implementer → critic (fail) → revise → critic");
  ok(first.result.tokensUsed === first.billed, "attempt 1 reports exactly what it spent");

  const retry = await attempt("retry");
  ok(
    retry.passes === 2 && retry.reviews === 2,
    "the retry gets its own review budget: the critic → implementer revision runs again",
  );
  ok(retry.result.verdict?.pass === true, "the retry ends on the critic's approval of its revision");
  ok(
    retry.result.tokensUsed === retry.billed,
    "the retry reports only its OWN tokens — attempt 1's spend is not reported twice",
  );
  ok(
    retry.firstPrompt.includes("summary of pass 2"),
    "the retry still reads attempt 1's final summary (the worktree it inherits)",
  );
  ok(retry.firstPrompt.includes("issue from review 2"), "the retry still reads attempt 1's last critic issues");
}

// ── 2. through runMission: spent_tokens is what was billed, so the budget holds ──
{
  const mission: Mission = {
    id: "m1",
    projectId: "p1",
    goal: "Ship the answer",
    acceptanceCriteria: [],
    checks: [],
    repoPath: "/repo",
    status: "running",
    // Room for exactly two honest attempts: a retry that re-bills attempt 1 overruns it.
    budget: 2 * ATTEMPT_TOKENS + 1,
    spentTokens: 0,
    deadline: null,
    guidance: null,
    iterations: 0,
    noProgress: 0,
    stopReason: null,
    prUrl: null,
    publishNote: null,
    issueNumber: null,
    createdAt: "t",
  };
  const items = new Map<string, BacklogItem>([
    [
      "item-1",
      {
        id: "item-1",
        missionId: "m1",
        title: "Set answer = 42 in src/answer.ts",
        detail: "",
        verify: "",
        status: "todo",
        priority: 0,
        dependsOn: [],
        risk: "low",
        runId: null,
        verification: null,
        diff: null,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  ]);
  const unused = () => {
    throw new Error("unused");
  };
  const store: BacklogStore = {
    createMission: unused,
    async getMission(id) {
      return id === mission.id ? { ...mission } : null;
    },
    listMissions: unused,
    async updateMission(id, patch) {
      if (id !== mission.id) return null;
      Object.assign(mission, patch);
      return { ...mission };
    },
    deleteMission: unused,
    createItem: unused,
    async getItem(id) {
      const i = items.get(id);
      return i ? { ...i } : null;
    },
    async listItems() {
      return [...items.values()].map((i) => ({ ...i }));
    },
    async updateItem(id, patch) {
      const i = items.get(id);
      if (!i) return null;
      Object.assign(i, patch);
      return { ...i };
    },
    async nextActionable() {
      const next = [...items.values()].find((i) => i.status === "todo");
      return next ? { ...next } : null;
    },
  };

  // Red on the first attempt, green on the retry.
  let verifications = 0;
  const verifier: Verifier = {
    async run(checks) {
      const passed = ++verifications > 1;
      return { passed, results: checks.map((check) => ({ check, passed, output: passed ? "" : "1 test failed" })) };
    },
  };
  // What the production replanner does with a failed check: keep the item open for a retry.
  const replanner: Replanner = {
    async replan({ verification }) {
      return { itemStatus: verification.passed ? "done" : "todo" };
    },
  };

  const model = new FakeTeamModel(verdicts);
  const out = await runMission({ backlog: store, verifier, runner: makeRunner(model), replanner }, "m1");
  console.log(`runMission: ${out.status}/${out.reason}, spent_tokens ${mission.spentTokens}, billed ${model.billed}`);
  ok(
    mission.spentTokens === model.billed,
    "spent_tokens equals what the model billed across both attempts (no double counting)",
  );
  ok(
    out.status === "done" && out.reason === "done" && items.get("item-1")!.status === "done",
    "the item is done on its retry, and the honest spend stays inside the budget",
  );
}

console.log("\nRetried item starts a fresh attempt ✓");
