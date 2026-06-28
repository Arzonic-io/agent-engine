import {
  buildDigest,
  createImplementerGraph,
  createMissionTeamGraph,
  createWorktreeWorkRunner,
  makeDecomposer,
  makeReplanner,
  makeTestAuthor,
  pickModel,
  runMission,
  type MissionGovernors,
  type RunnableMissionGraph,
} from "@arzonic/agent-core";
import {
  AppSettingsService,
  buildRoleModels,
  createConsoleNotifier,
  createGitDiffer,
  createGitIntegrator,
  createVerifier,
  createWebhookNotifier,
  createWritableRepoTools,
  createWorktreeManager,
  ensureGitBranch,
  getModel,
  installWorktreeDeps,
  isTransientLlmError,
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
  // Console first, plus an out-of-band webhook (blocker 1) when configured — so a
  // parked high-risk item or the morning digest actually reaches a sleeping human
  // instead of sitting only in PM2 logs. Best-effort: a webhook failure is logged,
  // never thrown into the loop.
  const notifier = createConsoleNotifier({
    also: env.MISSION_NOTIFY_WEBHOOK_URL
      ? [
          createWebhookNotifier({
            url: env.MISSION_NOTIFY_WEBHOOK_URL,
            onError: (err) =>
              console.warn(
                "[mission-worker] notify webhook failed:",
                err instanceof Error ? err.message : err,
              ),
          }),
        ]
      : [],
  });
  // Global default team config, editable at runtime from the settings UI. Read
  // fresh each scan so a change is picked up within a poll cycle.
  const settings = new AppSettingsService({ connectionString: env.SUPABASE_DB_URL });
  await settings.setup();

  if (!backlog) {
    console.error("[mission-worker] backlog unavailable — exiting.");
    process.exit(1);
  }

  const governors: MissionGovernors = {
    maxIterations: env.MISSION_MAX_ITERATIONS,
    tokenBudget: env.MISSION_TOKEN_BUDGET ?? null,
    noProgressLimit: env.MISSION_NOPROGRESS_LIMIT,
    thrashLimit: env.MISSION_THRASH_LIMIT,
    concurrency: env.MISSION_CONCURRENCY,
    requeueLimit: env.MISSION_REQUEUE_LIMIT,
    // Self-direction (blocker 3): when the backlog drains the controller re-decomposes
    // toward the goal up to this many times instead of stopping "done" immediately.
    maxStrategicReplans: env.MISSION_MAX_STRATEGIC_REPLANS,
  };

  const roleSummary = Object.entries(env.LLM_ROLE_MODELS ?? {})
    .map(([role, spec]) => `${role}=${spec.provider}${spec.model ? `:${spec.model}` : ""}`)
    .join(", ");
  console.log(
    `[mission-worker] v${APP_VERSION} up | provider: ${env.LLM_PROVIDER} | ` +
      `roles: ${roleSummary || "default everywhere"} | ` +
      `memory: ${memory ? "on" : "off"} | checks: ${env.MISSION_CHECKS.join(",")} | ` +
      `review: ${env.MISSION_REVIEW_ROUNDS > 0 ? `${env.MISSION_REVIEW_ROUNDS} round(s)` : "off"} | ` +
      `tests: ${
        env.MISSION_AUTHOR_TESTS
          ? env.MISSION_CHECKS.some((c) => /test/i.test(c))
            ? "author-on"
            : "author-on (⚠ no test check in MISSION_CHECKS — authored tests won't run)"
          : "off"
      } | ` +
      `concurrency: ${env.MISSION_CONCURRENCY} | ` +
      `retries: ${env.MISSION_LLM_MAX_RETRIES} llm / ${env.MISSION_REQUEUE_LIMIT} requeue | ` +
      `poll: ${env.MISSION_WORKER_POLL_MS}ms | ` +
      `notify: ${env.MISSION_NOTIFY_WEBHOOK_URL ? "console+webhook" : "console"} | ` +
      `digest: ${
        env.MISSION_DIGEST_INTERVAL_MS
          ? `every ${Math.round(env.MISSION_DIGEST_INTERVAL_MS / 60000)}m`
          : "on-stop"
      } | ` +
      `strategic-replan: ${env.MISSION_MAX_STRATEGIC_REPLANS} | ` +
      `abort-poll: ${env.MISSION_ABORT_POLL_MS}ms`,
  );

  let stopping = false;
  // Scheduled mid-run digest (blocker 1): runs on its own timer, independent of the
  // serial mission scan, so a mission that legitimately runs for hours still pushes
  // "here's what happened" before morning — not only its terminal digest.
  let digestTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    stopping = true;
    if (digestTimer) clearInterval(digestTimer);
    console.log("[mission-worker] shutdown requested — finishing current mission, then exiting.");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (env.MISSION_DIGEST_INTERVAL_MS) {
    digestTimer = setInterval(() => {
      void (async () => {
        try {
          const live = (await backlog.listMissions()).filter((m) => m.status === "running");
          for (const m of live) {
            const items = await backlog.listItems(m.id);
            await notifier.notify({
              type: "mission_digest",
              missionId: m.id,
              digest: buildDigest(m, items, env.MISSION_HIGH_RISK_PATTERNS),
            });
          }
        } catch (err) {
          console.warn(
            "[mission-worker] scheduled digest failed:",
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }, env.MISSION_DIGEST_INTERVAL_MS);
    digestTimer.unref?.();
  }

  while (!stopping) {
    const running = (await backlog.listMissions()).filter((m) => m.status === "running");
    // The UI-editable global default team config — re-read each scan so a change
    // in settings takes effect on the next mission iteration.
    const globalDefault = await settings.getRoleModels();
    for (const mission of running) {
      if (stopping) break;
      // Write-capable execution: one isolated worktree per item, the implementer
      // graph authoring real code in it (rooted via WritableRepoTools), deps
      // installed before checks. The Verifier runs in the item's worktree, then
      // green items merge into the mission branch and are re-verified there.
      // Both branches live under mission/<id>/ so neither is a ref-name prefix
      // of the other (git forbids a ref that is also a directory of refs).
      const missionBranch = `mission/${mission.id}/integration`;
      try {
        await ensureGitBranch(mission.repoPath, missionBranch);
      } catch (err) {
        console.error(
          `[mission-worker] could not prepare branch ${missionBranch}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const worktrees = createWorktreeManager(mission.repoPath);
      // This mission's team config: its stored role→model choices merged over the
      // global default (which is itself merged over the env baseline inside
      // buildRoleModels). Precedence: mission > global default (DB) > env. Active
      // mission roles are implementer (writes code), replan (done + follow-ups)
      // and decompose (plans backlog); unassigned roles fall back to the default
      // model. Built per mission so each can use its own team.
      const missionModels = buildRoleModels(env, { ...globalDefault, ...mission.roleModels });
      // The replan agent sees the current backlog titles so it avoids duplicates.
      const replanner = makeReplanner(pickModel(model, "replan", missionModels), {
        backlogTitles: async ({ mission: m }) =>
          (await backlog.listItems(m.id)).map((i) => i.title),
      });
      // The decomposer grows the initial backlog from the goal (M3 Trin 1), only
      // when the backlog is empty (a resume / hand-seed never re-plans).
      const decomposer = makeDecomposer(pickModel(model, "decompose", missionModels));
      // The tester authors a test that exercises each item before verification
      // (M3 Trin 2) so a green build is real evidence. Built with the same
      // worktree-rooted, allowlisted write tools as the implementer; injected only
      // when MISSION_AUTHOR_TESTS is on (omitted ⇒ pre-Trin-2 behaviour).
      const testAuthor = makeTestAuthor(pickModel(model, "tester", missionModels), {
        repo: (worktree) =>
          createWritableRepoTools(worktree, {
            allowedChecks: env.REPO_ALLOWED_CHECKS,
            allowedCommands: env.REPO_ALLOWED_COMMANDS,
          }),
      });
      const runner = createWorktreeWorkRunner({
        worktrees,
        baseRef: missionBranch,
        branch: (item) => `mission/${mission.id}/item/${item.id}`,
        prepare: async (wt) => {
          const install = await installWorktreeDeps(wt.path);
          if (!install.passed) {
            console.warn(`[mission-worker] deps install in ${wt.path} (${install.status}) — checks may fail.`);
          }
        },
        buildGraph: (wt) => {
          const repo = createWritableRepoTools(wt.path, {
            allowedChecks: env.REPO_ALLOWED_CHECKS,
            allowedCommands: env.REPO_ALLOWED_COMMANDS,
          });
          // With review on (★), each item runs implementer → critic → revise,
          // the critic challenging the real diff with the configured critic
          // model. With it off (0), the lone implementer (pre-★ behaviour).
          return (
            env.MISSION_REVIEW_ROUNDS > 0
              ? createMissionTeamGraph({
                  model,
                  models: missionModels,
                  checkpointer: checkpointer.saver,
                  repo,
                  reviewRounds: env.MISSION_REVIEW_ROUNDS,
                })
              : createImplementerGraph({
                  model,
                  models: missionModels,
                  checkpointer: checkpointer.saver,
                  repo,
                })
          ) as RunnableMissionGraph;
        },
      });
      const verifier = createVerifier(mission.repoPath, {
        allowedChecks: env.REPO_ALLOWED_CHECKS,
      });
      const integrator = createGitIntegrator(mission.repoPath, { missionBranch, worktrees });
      // Capture each item's authored diff (M3 Trin 5) so the dashboard can show a
      // human what was written — especially before approving a parked item.
      const differ = createGitDiffer();
      // Preemptive stop (blocker 2): a watcher re-reads the mission while it runs
      // and ABORTS the in-flight work the moment the kill switch flips status, the
      // wall-clock deadline passes, or the budget is exceeded — so Stop/deadline no
      // longer have to wait for the current batch to finish. The signal is forwarded
      // through runMission → runner → the graph's model calls; an aborted run is
      // re-queued cleanly (the controller's `aborted` path), and the loop's next top
      // check stops the mission with the right reason.
      const abort = new AbortController();
      const watcher = setInterval(() => {
        void (async () => {
          try {
            const m = await backlog.getMission(mission.id);
            if (!m) return;
            const overBudget = m.budget != null && m.spentTokens >= m.budget;
            const pastDeadline = m.deadline != null && Date.now() >= Date.parse(m.deadline);
            if (m.status !== "running" || overBudget || pastDeadline) abort.abort();
          } catch {
            // A transient DB blip — just try again on the next tick.
          }
        })();
      }, env.MISSION_ABORT_POLL_MS);
      watcher.unref?.();
      try {
        const outcome = await runMission(
          {
            backlog,
            verifier,
            runner,
            integrator,
            differ,
            decomposer,
            testAuthor: env.MISSION_AUTHOR_TESTS ? testAuthor : undefined,
            replanner,
            notifier,
            clock: { now: () => Date.now() },
            governors,
            // Drift-robustness (M3 Trin 3): a transient/infra run failure re-queues
            // the item instead of failing it; LLM-level retry already absorbed the
            // shorter blips before they reach here.
            isTransientError: isTransientLlmError,
            checks: env.MISSION_CHECKS,
            highRiskPatterns: env.MISSION_HIGH_RISK_PATTERNS,
            signal: abort.signal,
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
      } finally {
        clearInterval(watcher);
      }
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, env.MISSION_WORKER_POLL_MS));
  }

  if (digestTimer) clearInterval(digestTimer);
  await checkpointer.close();
  await backlog.end();
  await settings.end();
  if (memory) await memory.end();
  console.log("[mission-worker] stopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
