import type { MissionEvent, Notifier } from "@arzonic/agent-core";

/**
 * Log-first Notifier (§5.5 / build-order Trin 7: "dashboard/log first"). Mission
 * events go to a sink — stdout by default — so parked items, completions, and
 * stops are visible now, before real Slack/email transport lands (out of scope
 * for now). Also fans out to extra notifiers so the API can tee events to an SSE
 * stream while still logging.
 */

export interface ConsoleNotifierOptions {
  /** Where lines go. Defaults to console.log. */
  sink?: (line: string) => void;
  /** Additional notifiers to forward each event to (e.g. an SSE bridge). */
  also?: Notifier[];
}

function describe(e: MissionEvent): string {
  switch (e.type) {
    case "item_started":
      return `▶ item started: ${e.item.title}`;
    case "item_finished":
      return `${e.status === "done" ? "✓" : "✗"} item ${e.status}: ${e.item.title}`;
    case "item_parked":
      return `⏸ parked (${e.reason}, needs human): ${e.item.title}`;
    case "item_retried":
      return `↻ retry #${e.attempt} (transient: ${e.reason}): ${e.item.title}`;
    case "mission_digest": {
      const d = e.digest;
      const lines = [
        `📋 digest — ${d.done.length} done · ${d.parked.length} parked · ${d.pending} pending · ${d.failed.length} failed · ${d.spentTokens} tokens`,
      ];
      if (d.blocked.length) {
        lines.push(`  blocking: ${d.blocked.map((b) => `${b.title} (${b.reason})`).join("; ")}`);
      }
      if (d.nextHighRisk.length) lines.push(`  next high-risk: ${d.nextHighRisk.join("; ")}`);
      if (d.next.length) lines.push(`  next up: ${d.next.slice(0, 5).join("; ")}`);
      if (d.prUrl) lines.push(`  🔀 PR: ${d.prUrl}`);
      else if (d.publishNote) lines.push(`  publish: ${d.publishNote}`);
      return lines.join("\n");
    }
    case "mission_stopped":
      return `■ mission ${e.status} — ${e.reason}`;
  }
}

export function createConsoleNotifier(options: ConsoleNotifierOptions = {}): Notifier {
  const sink = options.sink ?? ((l: string) => console.log(l));
  const also = options.also ?? [];
  return {
    async notify(event: MissionEvent): Promise<void> {
      sink(`[mission ${event.missionId}] ${describe(event)}`);
      await Promise.all(also.map((n) => n.notify(event)));
    },
  };
}

/** Event types worth pushing out-of-band by default — the human-actionable ones. */
const DEFAULT_WEBHOOK_EVENTS: MissionEvent["type"][] = [
  "item_parked",
  "mission_digest",
  "mission_stopped",
];

export interface WebhookNotifierOptions {
  /** Endpoint that receives a JSON POST per event (Slack/Discord/Mattermost incoming webhook, or any custom sink). */
  url: string;
  /**
   * Which event types to deliver. Default: the human-actionable ones
   * (parked items, the digest, mission stop) — NOT the noisy per-item start/finish/retry
   * chatter, which would spam an overnight channel. Pass an explicit list to widen/narrow.
   */
  events?: MissionEvent["type"][];
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Called when delivery throws (network down, 5xx). A transport MUST NOT throw into
   * the mission loop — a failed notification can never crash a run — so errors are
   * swallowed and surfaced here for logging only.
   */
  onError?: (err: unknown, event: MissionEvent) => void;
}

/**
 * Out-of-band Notifier (blocker 1 — the async overseer must be reachable while
 * asleep). POSTs `{ text, event }` to a webhook per event: `text` is the same
 * human-readable line the console logs (so Slack/Discord/Mattermost incoming
 * webhooks, which render a top-level `text` field, work out of the box), and the
 * full structured `event` rides along for custom consumers. Best-effort: delivery
 * failures are caught and reported via `onError`, never thrown into the loop. Wire
 * it into the console notifier's `also` fan-out so a parked high-risk item at 3am
 * actually reaches a human instead of sitting silently in PM2 logs.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions): Notifier {
  const events = new Set(options.events ?? DEFAULT_WEBHOOK_EVENTS);
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async notify(event: MissionEvent): Promise<void> {
      if (!events.has(event.type)) return;
      const text = `[mission ${event.missionId}] ${describe(event)}`;
      try {
        const res = await doFetch(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, event }),
        });
        if (!res.ok) {
          options.onError?.(new Error(`webhook responded ${res.status}`), event);
        }
      } catch (err) {
        options.onError?.(err, event);
      }
    },
  };
}
