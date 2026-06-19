import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createRepoAnalysisGraph,
  type GraphStateType,
} from "@arzonic/agent-core";
import { buildRoleModels, getModel, loadEnv } from "@arzonic/agent-shared";
import { MemorySaver } from "@langchain/langgraph";
import { createRepoTools } from "./tools/repoTools.js";

const hr = () => console.log("─".repeat(72));

function printUpdate(update: Record<string, unknown>): void {
  for (const [node, value] of Object.entries(update)) {
    const patch = value as Partial<GraphStateType> | undefined;
    hr();
    console.log(`▶ ${node}`);
    if (!patch) continue;
    if (node === "analyst") {
      // The analyst's transcript messages include its tool-call trace.
      for (const msg of patch.messages ?? []) {
        if (msg.content.startsWith("🔧")) console.log(`  ${msg.content}`);
      }
      console.log(`  round ${patch.round}, tokens used: ${patch.tokensUsed}`);
    } else if (node === "critic" && patch.verdict) {
      const v = patch.verdict;
      console.log(`  verdict: pass=${v.pass} score=${v.score}`);
      for (const issue of v.issues) console.log(`  - ${issue}`);
    } else if (patch.status) {
      console.log(`  status: ${patch.status}`);
    }
  }
}

async function main(): Promise<void> {
  const [repoArg, ...taskParts] = process.argv.slice(2);
  const task = taskParts.join(" ");
  if (!repoArg || !task) {
    console.error('Usage: pnpm analyze <repoPath> "<task>"');
    console.error(
      '  e.g. pnpm analyze . "Find the 3 highest-impact improvements in this repo"',
    );
    process.exit(1);
  }

  const repoPath = resolve(repoArg);
  const env = loadEnv();
  const model = getModel(env);
  const tools = createRepoTools(repoPath, {
    allowedChecks: env.REPO_ALLOWED_CHECKS,
  });
  const graph = createRepoAnalysisGraph({
    model,
    models: buildRoleModels(env),
    tools,
    checkpointer: new MemorySaver(),
    guardrails: { maxRounds: env.MAX_ROUNDS, tokenBudget: env.RUN_TOKEN_BUDGET },
  });

  const threadId = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.RUN_TIMEOUT_MS);
  const config = {
    configurable: { thread_id: threadId },
    signal: controller.signal,
  };

  console.log(
    `repo: ${repoPath}\nprovider: ${env.LLM_PROVIDER} | max rounds: ${env.MAX_ROUNDS} | checks: ${env.REPO_ALLOWED_CHECKS.join(", ")}`,
  );

  try {
    console.log("\n⏳ Analyst arbejder… (læser filer + kører checks, kan tage et øjeblik pr. trin)");
    const stream = await graph.stream(
      { task, status: "running" },
      { ...config, streamMode: "updates" },
    );
    for await (const update of stream) {
      printUpdate(update as Record<string, unknown>);
    }

    const final = (await graph.getState(config)).values as GraphStateType;
    hr();
    console.log("ANALYSIS REPORT");
    console.log(
      `status: ${final.status} | rounds: ${final.round} | tokens: ${final.tokensUsed}`,
    );
    console.log(`\n${final.draft || "(no report produced)"}\n`);
    hr();
    console.log("VERDICT");
    console.log(JSON.stringify(final.verdict, null, 2));
  } catch (err) {
    if (controller.signal.aborted) {
      console.error(`\nRun timed out after ${env.RUN_TIMEOUT_MS} ms and was aborted.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
