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
