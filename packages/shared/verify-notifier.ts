/**
 * Throwaway proof of the out-of-band webhook Notifier (blocker 1) — no network, an
 * injected fake `fetch`. Proves: the human-actionable events are POSTed as
 * `{ text, event }`, the noisy per-item chatter is filtered out by default, an
 * explicit event list overrides the default, a delivery failure is swallowed (never
 * thrown into the loop) and surfaced via onError, and the console notifier's `also`
 * fan-out tees every event to the webhook while still logging.
 *
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-notifier.ts
 */
import type { MissionEvent } from "@arzonic/agent-core";
import { createConsoleNotifier, createWebhookNotifier } from "./src/notifier.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const fakeItem = {
  id: "i1",
  missionId: "m1",
  title: "Deploy to production",
  detail: "",
  status: "blocked_needs_human" as const,
  priority: 0,
  dependsOn: [],
  risk: "high" as const,
  runId: null,
  verification: null,
  diff: null,
  createdAt: "t",
  updatedAt: "t",
};

const parked: MissionEvent = { type: "item_parked", missionId: "m1", item: fakeItem, reason: "high-risk" };
const started: MissionEvent = { type: "item_started", missionId: "m1", item: fakeItem };
const stopped: MissionEvent = { type: "mission_stopped", missionId: "m1", status: "stopped", reason: "stopped" };

// ── 1. Default delivers the human-actionable events; filters the chatter ──
{
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const n = createWebhookNotifier({ url: "https://hooks.example/x", fetchImpl });
  await n.notify(parked);
  await n.notify(started); // chatter — must be filtered out by default
  await n.notify(stopped);

  ok(calls.length === 2, "default delivers exactly the human-actionable events (parked + stopped)");
  ok(calls.every((c) => c.url === "https://hooks.example/x"), "POSTs to the configured url");
  ok(
    calls[0]!.body.event.type === "item_parked" && typeof calls[0]!.body.text === "string",
    "payload carries the structured event AND a human-readable text line",
  );
  ok(
    /parked/i.test(calls[0]!.body.text) && /Deploy to production/.test(calls[0]!.body.text),
    "text line describes the parked item (Slack/Discord-renderable)",
  );
  ok(calls.find((c) => c.body.event.type === "item_started") === undefined, "item_started chatter is NOT delivered");
}

// ── 2. An explicit events list overrides the default filter ──
{
  const calls: MissionEvent["type"][] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body).event.type);
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const n = createWebhookNotifier({ url: "u", events: ["item_started"], fetchImpl });
  await n.notify(parked); // not in the list now
  await n.notify(started);
  ok(calls.length === 1 && calls[0] === "item_started", "explicit events list overrides the default");
}

// ── 3. A delivery failure is swallowed (never throws) and reported via onError ──
{
  let captured: unknown;
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const n = createWebhookNotifier({
    url: "u",
    fetchImpl,
    onError: (err) => (captured = err),
  });
  await n.notify(parked); // must not throw
  ok(captured instanceof Error && /network down/.test((captured as Error).message), "fetch throw is caught + reported");

  // A non-2xx response is also reported, not silently treated as success.
  let captured2: unknown;
  const fetch500 = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
  const n2 = createWebhookNotifier({ url: "u", fetchImpl: fetch500, onError: (e) => (captured2 = e) });
  await n2.notify(stopped);
  ok(captured2 instanceof Error && /500/.test((captured2 as Error).message), "non-2xx response is reported via onError");
}

// ── 4. console notifier `also` fan-out tees events to the webhook AND logs ──
{
  const logs: string[] = [];
  const delivered: MissionEvent["type"][] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    delivered.push(JSON.parse(init.body).event.type);
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const webhook = createWebhookNotifier({ url: "u", fetchImpl });
  const notifier = createConsoleNotifier({ sink: (l) => logs.push(l), also: [webhook] });
  await notifier.notify(parked);
  ok(logs.length === 1 && /parked/i.test(logs[0]!), "console still logs the event");
  ok(delivered.length === 1 && delivered[0] === "item_parked", "the same event is teed to the webhook via `also`");
}

console.log("\n🎉 verify-notifier PASSED — out-of-band webhook delivery + fan-out.\n");
