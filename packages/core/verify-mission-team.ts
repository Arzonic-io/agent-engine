/**
 * Throwaway proof for the mission team graph (M3 ★ — the team challenges each
 * item): implementer → critic (reviews the real git diff) → revise loop, bounded.
 * Uses a scripted fake model (no API key) that drives the implementer's tool calls
 * AND returns the critic's structured verdict, against a real temp git repo so the
 * critic's `git diff` actually runs. Proves: a failing review loops back with its
 * issues and the implementer revises; a pass ends the graph; and an always-failing
 * review still terminates (bounded by reviewRounds).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-mission-team.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWritableRepoTools } from "../shared/src/repoTools.js";
import { createMissionTeamGraph } from "./src/graph.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };

/**
 * A fake model that (a) replays scripted AI messages for the implementer's ReAct
 * loop via _generate, and (b) returns scripted structured verdicts for the critic
 * via withStructuredOutput. The two streams advance independently.
 */
class FakeTeamModel extends BaseChatModel {
  private stepI = 0;
  private verdictI = 0;
  constructor(
    private readonly steps: AIMessage[],
    private readonly verdicts: { pass: boolean; issues: string[] }[],
  ) {
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
        const v = this.verdicts[Math.min(this.verdictI, this.verdicts.length - 1)]!;
        this.verdictI += 1;
        return { raw: new AIMessage({ content: "", usage_metadata: usage }), parsed: v };
      },
    };
  }
  async _generate(_messages: unknown) {
    const msg = this.steps[Math.min(this.stepI, this.steps.length - 1)]!;
    this.stepI += 1;
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

const writeStep = (content: string, id: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name: "write_file", args: { path: "src/answer.ts", content }, id, type: "tool_call" }],
    usage_metadata: usage,
  });
const finalStep = (text: string) => new AIMessage({ content: text, usage_metadata: usage });

function initGitRepo(dir: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  execFileSync("node", ["-e", "require('fs').writeFileSync('README.md','base\\n')"], { cwd: dir });
  git("add", "-A");
  git("commit", "-qm", "base");
}

// ── 1. fail → revise → pass: the critic challenges, the implementer fixes ──
{
  const dir = await mkdtemp(join(tmpdir(), "verify-mteam-"));
  try {
    initGitRepo(dir);
    const repo = createWritableRepoTools(dir, { allowedCommands: ["git", "node"] });
    const model = new FakeTeamModel(
      [
        writeStep("export const answer = 1;\n", "w1"), // round 1: wrong
        finalStep("Skrev src/answer.ts (answer=1)."),
        writeStep("export const answer = 42;\n", "w2"), // round 2: fixed after critic
        finalStep("Rettede src/answer.ts (answer=42) efter review."),
      ],
      [
        { pass: false, issues: ["answer skal være 42, ikke 1"] },
        { pass: true, issues: [] },
      ],
    );
    const graph = createMissionTeamGraph({
      model: model as unknown as BaseChatModel,
      repo,
      checkpointer: new MemorySaver(),
      reviewRounds: 1,
    });
    const out = (await graph.invoke(baseState("Sæt answer = 42 i src/answer.ts"), {
      configurable: { thread_id: "t1" },
    })) as GraphStateType;

    ok((await readFile(join(dir, "src/answer.ts"), "utf8")).includes("answer = 42"), "the implementer revised the file after the critic challenged it");
    ok(out.verdict?.pass === true, "final verdict passes once the work is correct");
    ok(out.round === 2, "the implementer ran twice: initial + one revision");
    const failMsg = (out.messages ?? []).find((m) => m.content.includes("review: FAIL"));
    ok(!!failMsg && failMsg.content.includes("answer skal være 42"), "the critic's concrete issue was recorded for the implementer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 2. always-fail review still terminates (bounded by reviewRounds) ──
{
  const dir = await mkdtemp(join(tmpdir(), "verify-mteam-bound-"));
  try {
    initGitRepo(dir);
    const repo = createWritableRepoTools(dir, { allowedCommands: ["git", "node"] });
    const model = new FakeTeamModel(
      [writeStep("export const answer = 1;\n", "w1"), finalStep("v1"), writeStep("export const answer = 2;\n", "w2"), finalStep("v2")],
      [{ pass: false, issues: ["stadig forkert"] }], // every review fails
    );
    const graph = createMissionTeamGraph({
      model: model as unknown as BaseChatModel,
      repo,
      checkpointer: new MemorySaver(),
      reviewRounds: 1,
    });
    const out = (await graph.invoke(baseState("umulig opgave"), {
      configurable: { thread_id: "t2" },
    })) as GraphStateType;
    ok(out.round === 2, "an always-failing review stops after reviewRounds+1 implementer runs (no infinite loop)");
    ok(out.verdict?.pass === false, "the graph ends honestly red — the Verifier still decides done downstream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("\nMission team graph (★ team challenges each item) verified ✓");
