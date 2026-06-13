import type {
  DecisionRequest,
  DecisionResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from "./types.js";

export * from "./types.js";

export interface AgentClientOptions {
  /** e.g. http://127.0.0.1:8787 — no trailing slash needed. */
  baseUrl: string;
  /** AGENT_API_KEY. Server-side only — never ship this to a browser. */
  apiKey: string;
  fetch?: typeof fetch;
}

export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Agent API ${status}: ${message}`);
  }
}

export class AgentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new AgentApiError(res.status, await res.text());
    }
    return (await res.json()) as T;
  }

  startRun(request: StartRunRequest): Promise<StartRunResponse> {
    return this.request("/runs", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  getRun(runId: string): Promise<RunDetail> {
    return this.request(`/runs/${encodeURIComponent(runId)}`);
  }

  listRuns(): Promise<RunSummary[]> {
    return this.request("/runs");
  }

  decide(runId: string, decision: DecisionRequest): Promise<DecisionResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/decision`, {
      method: "POST",
      body: JSON.stringify(decision),
    });
  }

  /**
   * Subscribe to the SSE stream as an async iterator of typed events.
   * Ends when the server closes the stream (after `done`/`awaiting_human`).
   */
  async *streamRun(
    runId: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<RunEvent> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/stream`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: options?.signal,
      },
    );
    if (!res.ok || !res.body) {
      throw new AgentApiError(res.status, await res.text());
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (data) yield JSON.parse(data) as RunEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
