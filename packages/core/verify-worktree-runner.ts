/**
 * Throwaway proof for the M2 worktree WorkRunner (build-order Trin 4): an item
 * runs write-capably in its OWN git worktree, and the Verifier judges the
 * authored code THERE — not the untouched main repo. Wires the real worktree
 * manager + implementer graph (scripted fake model) + Verifier against a temp
 * git repo. No API key, no pnpm install (the check uses node builtins only).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-worktree-runner.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier } from "../shared/src/verifier.js";
import { createWritableRepoTools } from "../shared/src/repoTools.js";
import { createWorktreeManager } from "../shared/src/worktree.js";
import { createImplementerGraph } from "./src/graph.js";
import { createWorktreeWorkRunner, type RunnableMissionGraph } from "./src/runner.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

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
    return { generations: [{ text: typeof msg.content === "string" ? msg.content : "", message: msg }] };
  }
}

const repo = await mkdtemp(join(tmpdir(), "verify-wt-runner-"));
try {
  // A repo whose `check` script passes only when src/feature.ts exists — using
  // node builtins so it runs without an install.
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@t.t");
  g(repo, "config", "user.name", "t");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "wt-fixture",
      scripts: {
        check: "node -e \"process.exit(require('fs').existsSync('src/feature.ts')?0:1)\"",
      },
    }),
  );
  await writeFile(join(repo, "README.md"), "base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");

  const model = new ScriptedToolModel([
    new AIMessage({
      content: "",
      tool_calls: [{ name: "write_file", args: { path: "src/feature.ts", content: "export const n = 1;\n" }, id: "c1", type: "tool_call" }],
      usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    }),
    new AIMessage({ content: "Wrote src/feature.ts.", usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }),
  ]);

  const worktrees = createWorktreeManager(repo);
  const runner = createWorktreeWorkRunner({
    worktrees,
    branch: (item) => `mission/test/item/${item.id}`,
    buildGraph: (wt) =>
      createImplementerGraph({
        model: model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        repo: createWritableRepoTools(wt.path),
      }) as RunnableMissionGraph,
  });

  const result = await runner.run({ id: "item-1", title: "Add feature", context: "goal: add a feature" });

  ok(!!result.worktree && existsSync(result.worktree), "run returns the item's worktree path");
  ok(result.worktree!.includes(".agent-worktrees"), "worktree is under the manager's root");
  ok(existsSync(join(result.worktree!, "src/feature.ts")), "implementer authored the file IN the worktree");
  ok(!existsSync(join(repo, "src/feature.ts")), "the main repo is untouched (isolation)");
  ok(result.draft === "Wrote src/feature.ts.", "deliverable summary is returned");
  ok(result.tokensUsed === 20, "tokens summed across the run");

  // The crux: verification judges the worktree, not the untouched main repo.
  const verifier = createVerifier(repo, { allowedChecks: ["check"] });
  const inWorktree = await verifier.run(["check"], result.worktree);
  ok(inWorktree.passed, "Verifier PASSES in the worktree — it sees the authored code");
  const inMainRepo = await verifier.run(["check"]);
  ok(!inMainRepo.passed, "Verifier FAILS in the main repo — proving it judged the worktree, not the repo");

  console.log("\nM2 worktree WorkRunner verified ✓");
} finally {
  await rm(repo, { recursive: true, force: true });
}
