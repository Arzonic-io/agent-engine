import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  createAgentGraph,
  type AgentGraph,
  type GraphStateType,
  type HumanDecision,
  type HumanGatePayload,
} from "@arzonic/agent-core";
import { buildRoleModels, getModel, loadEnv } from "@arzonic/agent-shared";
import { Command } from "@langchain/langgraph";
import { createCheckpointer } from "./checkpointer.js";

interface CliArgs {
  task: string | null;
  threadId: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const rest: string[] = [];
  let threadId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--thread") {
      threadId = argv[++i] ?? null;
    } else {
      rest.push(argv[i]!);
    }
  }
  return { task: rest.length > 0 ? rest.join(" ") : null, threadId };
}

const hr = () => console.log("─".repeat(72));

function printUpdate(update: Record<string, unknown>): void {
  for (const [node, value] of Object.entries(update)) {
    if (node === "__interrupt__") continue;
    const patch = value as Partial<GraphStateType> | undefined;
    hr();
    console.log(`▶ ${node}`);
    if (!patch) continue;
    if (node === "builder") {
      console.log(`  round ${patch.round}, tokens used: ${patch.tokensUsed}`);
      const preview = (patch.draft ?? "").replace(/\s+/g, " ").slice(0, 200);
      console.log(`  draft: ${preview}${preview.length >= 200 ? "…" : ""}`);
    } else if (node === "critic" && patch.verdict) {
      const v = patch.verdict;
      console.log(
        `  verdict: pass=${v.pass} score=${v.score}, tokens used: ${patch.tokensUsed}`,
      );
      for (const issue of v.issues) console.log(`  - ${issue}`);
    } else if (patch.status) {
      console.log(`  status: ${patch.status}`);
    }
  }
}

function extractInterrupt(
  update: Record<string, unknown>,
): HumanGatePayload | null {
  const interrupts = update["__interrupt__"] as
    | Array<{ value: HumanGatePayload }>
    | undefined;
  return interrupts?.[0]?.value ?? null;
}

async function promptDecision(payload: HumanGatePayload): Promise<HumanDecision> {
  hr();
  console.log(`⏸  HUMAN GATE — ${payload.note}`);
  console.log(
    `   round ${payload.round}, score ${payload.verdict?.score ?? "n/a"}`,
  );
  console.log("\n--- Draft under review ---\n");
  console.log(payload.draft);
  console.log("\n--------------------------\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("Approve draft? [a]pprove / [r]eject: "))
        .trim()
        .toLowerCase();
      if (answer === "a" || answer === "approve") return "approve";
      if (answer === "r" || answer === "reject") return "reject";
      console.log("Please answer 'a' or 'r'.");
    }
  } finally {
    rl.close();
  }
}

type GraphInput = Parameters<AgentGraph["stream"]>[0];

/** Stream one graph segment (fresh input or resume Command) until END or interrupt. */
async function runSegment(
  graph: AgentGraph,
  input: GraphInput,
  config: { configurable: { thread_id: string }; signal: AbortSignal },
): Promise<HumanGatePayload | null> {
  console.log("\n⏳ Agenterne arbejder… (hvert trin er et LLM-kald og kan tage 15-30s)");
  const stream = await graph.stream(input, {
    ...config,
    streamMode: "updates",
  });
  let pending: HumanGatePayload | null = null;
  for await (const update of stream) {
    printUpdate(update as Record<string, unknown>);
    pending = extractInterrupt(update as Record<string, unknown>) ?? pending;
  }
  return pending;
}

function printFinal(state: GraphStateType): void {
  hr();
  console.log("FINAL RESULT");
  console.log(`status: ${state.status} | rounds: ${state.round} | tokens: ${state.tokensUsed}`);
  console.log("\n=== Final draft ===\n");
  console.log(state.draft || "(no draft produced)");
  console.log("\n=== Verdict ===\n");
  console.log(JSON.stringify(state.verdict, null, 2));
  console.log("\n=== Transcript ===\n");
  for (const msg of state.messages) {
    console.log(`[${msg.agent}]`);
    console.log(msg.content);
    console.log();
  }
}

async function main(): Promise<void> {
  const { task, threadId: threadArg } = parseArgs(process.argv.slice(2));
  if (!task && !threadArg) {
    console.error('Usage: pnpm agent "<task>" [--thread <id>]');
    console.error("       pnpm agent --thread <id>   (resume an interrupted run)");
    process.exit(1);
  }

  const env = loadEnv();
  const model = getModel(env);
  const checkpointer = await createCheckpointer(env);
  const graph = createAgentGraph({
    model,
    models: buildRoleModels(env),
    checkpointer: checkpointer.saver,
    guardrails: {
      maxRounds: env.MAX_ROUNDS,
      tokenBudget: env.RUN_TOKEN_BUDGET,
    },
  });

  const threadId = threadArg ?? randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.RUN_TIMEOUT_MS);
  const config = {
    configurable: { thread_id: threadId },
    signal: controller.signal,
  };

  console.log(
    `thread: ${threadId} | provider: ${env.LLM_PROVIDER} | checkpointer: ${
      checkpointer.persistent ? "postgres" : "memory"
    } | max rounds: ${env.MAX_ROUNDS}`,
  );

  try {
    let pending: HumanGatePayload | null;
    if (task) {
      pending = await runSegment(graph, { task, status: "running" }, config);
    } else {
      // Resume an existing thread at its pending interrupt.
      const snapshot = await graph.getState(config);
      const existing = snapshot.tasks.flatMap((t) => t.interrupts ?? []);
      if (existing.length === 0) {
        console.error(
          `Thread ${threadId} has no pending human gate to resume (status: ${
            (snapshot.values as GraphStateType | undefined)?.status ?? "unknown"
          }).`,
        );
        process.exit(1);
      }
      pending = existing[0]!.value as HumanGatePayload;
    }

    // The human gate can only fire once per run, but loop defensively.
    while (pending) {
      const decision = await promptDecision(pending);
      pending = await runSegment(
        graph,
        new Command({ resume: decision }) as GraphInput,
        config,
      );
    }

    const finalState = await graph.getState(config);
    printFinal(finalState.values as GraphStateType);
  } catch (err) {
    if (controller.signal.aborted) {
      console.error(
        `\nRun timed out after ${env.RUN_TIMEOUT_MS} ms and was aborted (status: failed).` +
          (checkpointer.persistent
            ? ` Resume with: pnpm agent --thread ${threadId}`
            : ""),
      );
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
    await checkpointer.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
