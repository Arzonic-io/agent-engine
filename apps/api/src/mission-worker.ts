import {
  createImplementerGraph,
  createWorktreeWorkRunner,
  makeReplanner,
  runMission,
  type MissionGovernors,
  type RunnableMissionGraph,
} from "@arzonic/agent-core";
import {
  createConsoleNotifier,
  createVerifier,
  createWritableRepoTools,
  createWorktreeManager,
  getModel,
  installWorktreeDeps,
} from "@arzonic/agent-shared";
import { createBacklog } from "./backlog.provider.js";
import { createCheckpointer } from "./checkpointer.js";
import { loadApiEnv } from "./env.js";
import { createMemory } from "./memory.provider.js";

/**
 * The PM2 mission-worker (§5.7). A separate process from the API that shares the
 * same Postgres (checkpointer + backlog): it scans for `running` missions and
 * drives the pure `runMission` loop for each, one at a time (concurrent missions
 * on a repo are serialized — §7). The API owns intake, the kill switch, and the
 * parked-item decisions; this process does the work.
 *
 * Work items run write-capably (M2): each item gets its own git worktree, the
 * implementer graph authors real code there, deps are installed, and the Verifier
 * runs the checks against the AUTHORED code in that worktree.
 */

const APP_VERSION = "0.1.0";

async function main(): Promise<void> {
  const env = loadApiEnv();
  if (!env.SUPABASE_DB_URL) {
    console.error("[mission-worker] SUPABASE_DB_URL is required — missions need persistence.");
    process.exit(1);
  }

  const model = getModel(env);
  const checkpointer = await createCheckpointer(env);
  const backlog = await createBacklog(env);
  const memory = await createMemory(env);
  const notifier = createConsoleNotifier();

  if (!backlog) {
    console.error("[mission-worker] backlog unavailable — exiting.");
    process.exit(1);
  }

  // The replan agent sees the current backlog titles so it avoids duplicates.
  const replanner = makeReplanner(model, {
    backlogTitles: async ({ mission }) =>
      (await backlog.listItems(mission.id)).map((i) => i.title),
  });

  const governors: MissionGovernors = {
    maxIterations: env.MISSION_MAX_ITERATIONS,
    tokenBudget: env.MISSION_TOKEN_BUDGET ?? null,
    noProgressLimit: env.MISSION_NOPROGRESS_LIMIT,
    thrashLimit: env.MISSION_THRASH_LIMIT,
  };

  console.log(
    `[mission-worker] v${APP_VERSION} up | provider: ${env.LLM_PROVIDER} | ` +
      `memory: ${memory ? "on" : "off"} | checks: ${env.MISSION_CHECKS.join(",")} | ` +
      `poll: ${env.MISSION_WORKER_POLL_MS}ms`,
  );

  let stopping = false;
  const shutdown = () => {
    stopping = true;
    console.log("[mission-worker] shutdown requested — finishing current mission, then exiting.");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!stopping) {
    const running = (await backlog.listMissions()).filter((m) => m.status === "running");
    for (const mission of running) {
      if (stopping) break;
      // Write-capable execution: one isolated worktree per item, the implementer
      // graph authoring real code in it (rooted via WritableRepoTools), deps
      // installed before checks. The Verifier runs in the item's worktree.
      const worktrees = createWorktreeManager(mission.repoPath);
      const runner = createWorktreeWorkRunner({
        worktrees,
        branch: (item) => `mission/${mission.id}/item/${item.id}`,
        prepare: async (wt) => {
          const install = await installWorktreeDeps(wt.path);
          if (!install.passed) {
            console.warn(`[mission-worker] deps install in ${wt.path} (${install.status}) — checks may fail.`);
          }
        },
        buildGraph: (wt) =>
          createImplementerGraph({
            model,
            checkpointer: checkpointer.saver,
            repo: createWritableRepoTools(wt.path, {
              allowedChecks: env.REPO_ALLOWED_CHECKS,
              allowedCommands: env.REPO_ALLOWED_COMMANDS,
            }),
          }) as RunnableMissionGraph,
      });
      const verifier = createVerifier(mission.repoPath, {
        allowedChecks: env.REPO_ALLOWED_CHECKS,
      });
      try {
        const outcome = await runMission(
          {
            backlog,
            verifier,
            runner,
            replanner,
            notifier,
            clock: { now: () => Date.now() },
            governors,
            checks: env.MISSION_CHECKS,
            highRiskPatterns: env.MISSION_HIGH_RISK_PATTERNS,
          },
          mission.id,
        );
        console.log(
          `[mission-worker] mission ${mission.id} → ${outcome.status} (${outcome.reason}); ` +
            `${outcome.itemsDone} done over ${outcome.iterations} iterations.`,
        );
      } catch (err) {
        console.error(
          `[mission-worker] mission ${mission.id} crashed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, env.MISSION_WORKER_POLL_MS));
  }

  await checkpointer.close();
  await backlog.end();
  if (memory) await memory.end();
  console.log("[mission-worker] stopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
