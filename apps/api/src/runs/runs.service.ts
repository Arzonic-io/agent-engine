import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ReplaySubject, type Observable } from "rxjs";
import {
  createAgentGraph,
  defaultRubric,
  type AgentGraph,
  type GraphStateType,
  type Rubric,
} from "@arzonic/agent-core";
import type {
  ApiRunStatus,
  DecisionResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  StartRunResponse,
} from "@arzonic/agent-client";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command } from "@langchain/langgraph";
import type { CheckpointerHandle } from "../checkpointer.js";
import type { ApiEnv } from "../env.js";
import { CHECKPOINTER, ENV, MODEL } from "../tokens.js";
import type { DecisionDto, StartRunDto } from "./dto/runs.dto.js";

const REJECTION_MARKER = "Rejected final draft.";

/** Rubric registry — extend here when product-specific rubrics land. */
const RUBRICS: Record<string, Rubric> = {
  default: defaultRubric,
};

interface RunMeta {
  runId: string;
  task: string;
  createdAt: string;
  status: ApiRunStatus;
  events: ReplaySubject<RunEvent>;
  abort: AbortController;
}

type GraphInput = Parameters<AgentGraph["stream"]>[0];

@Injectable()
export class RunsService implements OnModuleDestroy {
  /** In-process registry for the list view + live event subjects. State itself lives in the checkpointer. */
  private readonly runs = new Map<string, RunMeta>();

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MODEL) private readonly model: BaseChatModel,
    @Inject(CHECKPOINTER) private readonly checkpointer: CheckpointerHandle,
  ) {}

  async onModuleDestroy(): Promise<void> {
    for (const meta of this.runs.values()) meta.abort.abort();
    await this.checkpointer.close();
  }

  private makeGraph(options?: StartRunDto["options"], rubricId?: string): AgentGraph {
    const rubric = RUBRICS[rubricId ?? "default"];
    if (!rubric) {
      throw new NotFoundException(
        `Unknown rubricId '${rubricId}'. Available: ${Object.keys(RUBRICS).join(", ")}`,
      );
    }
    return createAgentGraph({
      model: this.model,
      checkpointer: this.checkpointer.saver,
      rubric,
      guardrails: {
        maxRounds: options?.maxRounds ?? this.env.MAX_ROUNDS,
        tokenBudget: this.env.RUN_TOKEN_BUDGET,
      },
    });
  }

  private config(runId: string, signal?: AbortSignal) {
    return { configurable: { thread_id: runId }, signal };
  }

  start(dto: StartRunDto): StartRunResponse {
    const runId = randomUUID();
    const graph = this.makeGraph(dto.options, dto.rubricId);
    const meta: RunMeta = {
      runId,
      task: dto.task,
      createdAt: new Date().toISOString(),
      status: "running",
      events: new ReplaySubject<RunEvent>(),
      abort: new AbortController(),
    };
    this.runs.set(runId, meta);

    const timeout = setTimeout(() => meta.abort.abort(), this.env.RUN_TIMEOUT_MS);
    void this.consume(graph, meta, { task: dto.task, status: "running" })
      .catch((err: unknown) => {
        meta.status = "failed";
        meta.events.next({
          type: "error",
          message: meta.abort.signal.aborted
            ? `Run timed out after ${this.env.RUN_TIMEOUT_MS} ms`
            : err instanceof Error
              ? err.message
              : String(err),
        });
        meta.events.complete();
      })
      .finally(() => clearTimeout(timeout));

    return { runId, threadId: runId, status: "running" };
  }

  /** Drive one graph segment and translate updates into typed wire events. */
  private async consume(graph: AgentGraph, meta: RunMeta, input: GraphInput): Promise<void> {
    const stream = await graph.stream(input, {
      ...this.config(meta.runId, meta.abort.signal),
      streamMode: "updates",
    });

    for await (const chunk of stream) {
      const update = chunk as Record<string, Partial<GraphStateType>>;
      for (const [node, patch] of Object.entries(update)) {
        if (node === "builder" && patch) {
          meta.events.next({
            type: "node",
            node: "builder",
            round: patch.round ?? 0,
            content: patch.draft ?? "",
          });
        } else if (node === "critic" && patch?.verdict) {
          const round = await this.currentRound(graph, meta.runId);
          meta.events.next({
            type: "node",
            node: "critic",
            round,
            content: patch.verdict.issues.join("\n") || "no issues",
          });
          meta.events.next({
            type: "verdict",
            round,
            pass: patch.verdict.pass,
            score: patch.verdict.score,
            issues: patch.verdict.issues,
          });
        }
      }
    }

    // Segment ended: either paused at the human gate or terminal.
    const snapshot = await graph.getState(this.config(meta.runId));
    const state = snapshot.values as GraphStateType;
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);

    if (interrupted) {
      meta.status = "awaiting_human";
      meta.events.next({ type: "awaiting_human", runId: meta.runId });
      return; // subject stays open — decision() continues it
    }

    meta.status = this.mapStatus(state);
    meta.events.next({
      type: "done",
      status: meta.status,
      result: { draft: state.draft, verdict: state.verdict },
    });
    meta.events.complete();
  }

  private async currentRound(graph: AgentGraph, runId: string): Promise<number> {
    const snapshot = await graph.getState(this.config(runId));
    return (snapshot.values as GraphStateType | undefined)?.round ?? 0;
  }

  /** Core knows 'failed'; the API distinguishes a human rejection from a real failure. */
  private mapStatus(state: GraphStateType): ApiRunStatus {
    if (state.status === "failed") {
      const rejected = state.messages.some(
        (m) => m.agent === "human" && m.content === REJECTION_MARKER,
      );
      return rejected ? "rejected" : "failed";
    }
    return state.status;
  }

  async getRun(runId: string): Promise<RunDetail> {
    const graph = this.makeGraph();
    const snapshot = await graph.getState(this.config(runId));
    const state = snapshot.values as GraphStateType | undefined;
    if (!state || !state.task) {
      throw new NotFoundException(`No run found for id ${runId}`);
    }
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);
    return {
      runId,
      threadId: runId,
      status: interrupted ? "awaiting_human" : this.mapStatus(state),
      round: state.round,
      draft: state.draft,
      verdict: state.verdict,
      messages: state.messages,
    };
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ runId, task, status, createdAt }) => ({ runId, task, status, createdAt }));
  }

  async decide(runId: string, dto: DecisionDto): Promise<DecisionResponse> {
    const graph = this.makeGraph();
    const snapshot = await graph.getState(this.config(runId));
    const state = snapshot.values as GraphStateType | undefined;
    if (!state || !state.task) {
      throw new NotFoundException(`No run found for id ${runId}`);
    }
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);
    if (!interrupted) {
      throw new ConflictException(
        `Run ${runId} is not awaiting a human decision (status: ${this.mapStatus(state)})`,
      );
    }

    // Recreate meta after a restart so stream watchers still get the tail events.
    let meta = this.runs.get(runId);
    if (!meta) {
      meta = {
        runId,
        task: state.task,
        createdAt: new Date().toISOString(),
        status: "awaiting_human",
        events: new ReplaySubject<RunEvent>(),
        abort: new AbortController(),
      };
      this.runs.set(runId, meta);
    }

    await this.consume(graph, meta, new Command({ resume: dto.decision }) as GraphInput);

    if (dto.notes) {
      // Attach reviewer notes to the persisted transcript (post-terminal, best effort).
      try {
        await graph.updateState(this.config(runId), {
          messages: [{ agent: "human", role: "user", content: `Reviewer notes: ${dto.notes}` }],
        });
      } catch {
        // non-fatal: notes still live in the HTTP audit trail of the caller
      }
    }

    return { runId, status: meta.status };
  }

  events(runId: string): Observable<RunEvent> {
    const meta = this.runs.get(runId);
    if (!meta) {
      throw new NotFoundException(
        `No live event stream for run ${runId} (it may predate a restart — poll GET /runs/${runId} instead)`,
      );
    }
    return meta.events.asObservable();
  }
}
