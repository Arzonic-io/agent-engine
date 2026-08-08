"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IconType } from "react-icons";
import {
  LuActivity,
  LuArrowDown,
  LuArrowLeft,
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCode,
  LuCompass,
  LuCopy,
  LuCrown,
  LuFileText,
  LuGavel,
  LuHammer,
  LuLightbulb,
  LuRefreshCw,
  LuSearch,
  LuTerminal,
  LuTriangleAlert,
  LuUser,
  LuWrench,
  LuX,
} from "react-icons/lu";
import type { ApiVerdict, RunDetail, RunEvent } from "@arzonic/agent-client";
import { useEventStream, type StreamStatus } from "../../lib/useEventStream";

/**
 * `fromPersisted` marks an item rebuilt from the run's saved messages rather
 * than received live. Those are a placeholder for runs with no stream left to
 * replay; the moment the stream does speak it replays the full history itself,
 * so the placeholders are dropped rather than left to double up.
 */
type FeedItem = RunEvent & { key: string; t: number; fromPersisted?: boolean };

/** How long without a fresh event (while the stream isn't cleanly "open") before
 * we stop trusting the smooth "X is drafting" pulse and admit nothing's arrived
 * in a while — tied loosely to the backend's heartbeat interval (~20s). */
const STALE_AFTER_MS = 50_000;

/** How long an armed keyboard decision stays armed before it disarms itself. */
const ARM_TIMEOUT_MS = 4_000;

const AGENT: Record<
  string,
  { color: string; name: string; side: "left" | "right"; Icon: IconType }
> = {
  // One Danish name per role, matching the mission feed and team settings —
  // the same agent used to be "Builder" here, "Udvikler" there, "Worker" in a
  // third place, leaving the reader to translate between screens.
  builder: { color: "var(--color-builder)", name: "Udvikler", side: "left", Icon: LuHammer },
  analyst: { color: "var(--color-analyst)", name: "Analytiker", side: "left", Icon: LuSearch },
  architect: { color: "var(--color-analyst)", name: "Arkitekt", side: "left", Icon: LuCompass },
  worker: { color: "var(--color-builder)", name: "Udvikler", side: "left", Icon: LuWrench },
  implementer: { color: "var(--color-builder)", name: "Udvikler", side: "left", Icon: LuWrench },
  lead: { color: "var(--color-lead)", name: "Lead", side: "left", Icon: LuCrown },
  critic: { color: "var(--color-critic)", name: "Kritiker", side: "right", Icon: LuGavel },
  human: { color: "var(--color-human)", name: "Dig", side: "right", Icon: LuUser },
  system: { color: "var(--color-dim)", name: "System", side: "left", Icon: LuTerminal },
};

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  running: { text: "kører", cls: "text-builder" },
  awaiting_human: { text: "venter på dig", cls: "text-warning" },
  accepted: { text: "godkendt", cls: "text-success" },
  rejected: { text: "afvist", cls: "text-error" },
  failed: { text: "fejlet", cls: "text-error" },
};

/** Time of day only — seconds made "15.07.23" read as a date. */
const clock = (t: number) =>
  new Date(t).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });

/** "1t 4m" / "3m 12s" / "14s" — a duration, not a clock reading. */
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}t ${m % 60}m`;
}

/** Strip raw markdown (** , leading bullets) so issues read cleanly in the UI. */
const cleanIssue = (s: string) =>
  s.replace(/\*\*/g, "").replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim();

/** Rough markdown → plain text, for the "Copy as text" option. */
function mdToPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function Md({ children }: { children: string }) {
  return (
    <div className="md-body">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

function CopyMenu({ content }: { content: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked — ignore */
    }
  };
  return (
    <div className="dropdown dropdown-end">
      <button
        tabIndex={0}
        className="btn btn-ghost btn-xs gap-1 text-dim hover:text-fg"
        aria-label="Kopiér"
      >
        <LuCopy className="h-3.5 w-3.5" />
        {copied ? copied : "Kopiér"}
      </button>
      <ul
        tabIndex={0}
        className="menu dropdown-content z-50 mt-1 w-44 rounded-box border border-line bg-elev p-1 shadow-xl"
      >
        <li>
          <button onClick={() => copy(mdToPlain(content), "Kopieret ✓")}>
            <LuFileText className="h-4 w-4" /> Kopiér som tekst
          </button>
        </li>
        <li>
          <button onClick={() => copy(content, "Kopieret ✓")}>
            <LuCode className="h-4 w-4" /> Kopiér som markdown
          </button>
        </li>
      </ul>
    </div>
  );
}

export default function RunView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [rerunning, setRerunning] = useState(false);
  const [streaming, setStreaming] = useState<{ node: "builder" | "analyst"; content: string } | null>(null);
  const [status, setStatus] = useState("running");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** Keyboard decision waiting for its confirming second press (see the key handler). */
  const [armed, setArmed] = useState<"approve" | "reject" | null>(null);
  // Optional LangSmith traces deep link (null = tracing off / no URL configured).
  const [traceUrl, setTraceUrl] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok) setTraceUrl(((await res.json()) as { traceUrl?: string | null }).traceUrl ?? null);
      } catch {
        /* best-effort — the trace link just stays hidden */
      }
    })();
  }, []);

  const seenIds = useRef<Set<string>>(new Set());
  const seq = useRef(0);
  const startRef = useRef<number>(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);

  const refreshDetail = useCallback(async () => {
    const res = await fetch(`/api/runs/${id}`);
    if (res.ok) {
      const d = (await res.json()) as RunDetail;
      setDetail(d);
      setStatus(d.status);
      setAwaiting(d.status === "awaiting_human");
      setTokens((prev) => Math.max(prev, d.tokensUsed ?? 0));
    }
  }, [id]);

  // reset when switching runs
  useEffect(() => {
    setFeed([]);
    setStreaming(null);
    setStatus("running");
    setAwaiting(false);
    setTokens(0);
    seenIds.current = new Set();
    seq.current = 0;
    startRef.current = Date.now();
  }, [id]);

  // Initial fetch — fires immediately, independent of the stream connecting.
  useEffect(() => {
    void refreshDetail();
  }, [id, refreshDetail]);

  function handleRunEvent(event: RunEvent, raw: MessageEvent) {
    // Token stream → accumulate into the live "typing" buffer (not deduped/keyed).
    if (event.type === "token") {
      setStreaming((prev) =>
        prev && prev.node === event.node
          ? { node: event.node, content: prev.content + event.content }
          : { node: event.node, content: event.content },
      );
      return;
    }
    // Pure liveness signal, no domain content — `lastEventAt` is already
    // updated generically by the hook before `onEvent` runs (that's what the
    // staleness check in `activeLine` reads); never render it in the transcript.
    if (event.type === "heartbeat") return;

    const eid = raw.lastEventId || `seq-${(seq.current += 1)}`;
    if (seenIds.current.has(eid)) return;
    seenIds.current.add(eid);
    // The stream is authoritative once it starts talking: drop anything the
    // persisted-messages fallback put in first, or the two sources show the
    // same message twice (the fallback races the stream on a fresh run).
    setFeed((prev) => [
      ...prev.filter((f) => !f.fromPersisted),
      { ...event, key: eid, t: Date.now() },
    ]);
    if ((event.type === "node" || event.type === "verdict") && typeof event.tokens === "number")
      setTokens(event.tokens);
    // A finalized builder/analyst message supersedes the streaming buffer.
    if (event.type === "node") setStreaming(null);
    if (event.type === "awaiting_human") setAwaiting(true);
    if (event.type === "done") {
      setStatus(event.status);
      setAwaiting(false);
      void refreshDetail();
      // The run is genuinely over — stop reconnecting to a stream that will
      // never emit again (the server closing cleanly still looks like a
      // dropped connection to a naive EventSource, which would otherwise retry).
      stream.stop();
    }
    if (event.type === "error") {
      // Ambiguous over the wire: a genuine backend failure and the Next
      // proxy's synthetic "upstream unreachable" frame look identical. Never
      // set `status` from this directly — always re-derive it from the REST
      // GET (the source of truth); the hook's own retry loop keeps trying.
      void refreshDetail();
    }
  }

  const stream = useEventStream<RunEvent>(`/api/runs/${id}/stream`, {
    onEvent: handleRunEvent,
    // Every (re)connect and every drop re-syncs from the REST source of
    // truth — this is what actually fixes "nothing happens when I come
    // back", independent of whether the SSE stream itself ever recovers.
    onOpen: () => {
      // A reconnect replays the server's full (capped) event history; without
      // this the "typing" buffer would append onto stale pre-reconnect text.
      setStreaming(null);
      void refreshDetail();
    },
    onTransportError: () => void refreshDetail(),
  });

  // Old runs (from earlier sessions) have no live stream to replay — the API
  // only keeps the event stream for runs still in memory. Rebuild the transcript
  // from the persisted messages so previous sessions show their full content
  // instead of a blank conversation. Skips only if the live stream already filled it.
  useEffect(() => {
    if (!detail) return;
    setFeed((prev) => {
      if (prev.length > 0) return prev;
      const items: FeedItem[] = detail.messages
        .filter((m) => m.agent !== "critic") // critic is shown as the verdict card
        .map(
          (m, i) =>
            ({
              type: "node",
              node: m.agent,
              round: 0,
              content: m.content,
              key: `msg-${i}`,
              t: startRef.current + i,
              fromPersisted: true,
            }) as FeedItem,
        );
      if (detail.verdict) {
        items.push({
          type: "verdict",
          round: detail.round,
          pass: detail.verdict.pass,
          score: detail.verdict.score,
          issues: detail.verdict.issues,
          criteria: detail.verdict.criteria,
          key: "verdict-final",
          t: startRef.current + detail.messages.length,
          fromPersisted: true,
        } as FeedItem);
      }
      return items;
    });
  }, [detail]);

  const live = status === "running" || status === "awaiting_human";

  // Independent polling fallback: keeps status/tokens/Artifact fresh even if
  // the SSE stream is degraded or fully dead (mirrors MissionLiveFeed's pattern).
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void refreshDetail(), 5000);
    return () => clearInterval(t);
  }, [live, refreshDetail]);


  // Elapsed — measured from the run's real start (the API's startedAt), not
  // from when this tab happened to mount, so reopening an old run no longer
  // reports a few seconds. Falls back to mount time only for runs that predate
  // timestamp tracking; a finished run shows its final duration and stops.
  const startedAtMs = useMemo(() => {
    const t = detail?.startedAt ? Date.parse(detail.startedAt) : NaN;
    return Number.isNaN(t) ? null : t;
  }, [detail?.startedAt]);

  useEffect(() => {
    const base = startedAtMs ?? startRef.current;
    const finished = detail?.finishedAt ? Date.parse(detail.finishedAt) : NaN;
    if (!live && !Number.isNaN(finished)) {
      setElapsed(finished - base);
      return;
    }
    if (!live) return;
    setElapsed(Date.now() - base);
    const t = setInterval(() => setElapsed(Date.now() - base), 1000);
    return () => clearInterval(t);
  }, [live, startedAtMs, detail?.finishedAt]);

  // auto-scroll (also follows the live token buffer)
  useEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed.length, awaiting, atBottom, streaming?.content.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  const decide = useCallback(
    async (decision: "approve" | "reject" | "revise", notes?: string) => {
      if (!awaiting || deciding) return;
      setDeciding(true);
      setAwaiting(false);
      try {
        await fetch(`/api/runs/${id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, notes }),
        });
        await refreshDetail();
      } finally {
        setDeciding(false);
      }
    },
    [awaiting, deciding, id, refreshDetail],
  );

  // Override the router: re-run this task with the topology forced. Starts a
  // fresh run (the original stays intact) and navigates to it.
  const rerunAs = useCallback(
    async (topology: "single" | "team") => {
      if (rerunning) return;
      setRerunning(true);
      try {
        const res = await fetch(`/api/runs/${id}/rerun`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topology }),
        });
        if (res.ok) {
          const { runId } = (await res.json()) as { runId: string };
          router.push(`/runs/${runId}`);
        }
      } finally {
        setRerunning(false);
      }
    },
    [rerunning, id, router],
  );

  // Keyboard: A approve · R reject · G jump to gate. A decision can't be taken
  // back, so the shortcut arms first and commits on a second press — a stray
  // keystroke used to approve a run outright. The click path stays one-click.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
        return;
      if (e.key === "Escape") setArmed(null);
      if (e.key === "g") gateRef.current?.scrollIntoView({ behavior: "smooth" });
      if (!awaiting) return;
      const wanted = e.key === "a" ? "approve" : e.key === "r" ? "reject" : null;
      if (!wanted) return;
      if (armed === wanted) {
        setArmed(null);
        void decide(wanted);
      } else {
        setArmed(wanted);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [awaiting, armed, decide]);

  // derived inspector data
  // Compares round numbers rather than "whichever source has any match" — a
  // single early builder/lead event would otherwise pin the panel on stale
  // (possibly many-rounds-old) content forever, since `feed` never loses that
  // match and a fresher `detail.draft` from a poll (see refreshDetail above)
  // would never get a chance to win.
  const latestDraft = useMemo(() => {
    let fromFeed: { content: string; round: number } | null = null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const f = feed[i]!;
      if (
        f.type === "node" &&
        (f.node === "builder" || f.node === "analyst" || f.node === "lead") &&
        !f.content.startsWith("🔧")
      ) {
        fromFeed = { content: f.content, round: f.round };
        break;
      }
    }
    const fromDetail = detail?.draft ? { content: detail.draft, round: detail.round } : null;
    if (fromFeed && fromDetail) return fromFeed.round >= fromDetail.round ? fromFeed : fromDetail;
    return fromFeed ?? fromDetail;
  }, [feed, detail]);

  const latestVerdict = useMemo<{ v: ApiVerdict; round: number } | null>(() => {
    let fromFeed: { v: ApiVerdict; round: number } | null = null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const f = feed[i]!;
      if (f.type === "verdict") {
        fromFeed = { v: { pass: f.pass, score: f.score, issues: f.issues }, round: f.round };
        break;
      }
    }
    const fromDetail = detail?.verdict ? { v: detail.verdict, round: detail.round } : null;
    if (fromFeed && fromDetail) return fromFeed.round >= fromDetail.round ? fromFeed : fromDetail;
    return fromFeed ?? fromDetail;
  }, [feed, detail]);

  const round = useMemo(
    () => feed.reduce((m, f) => ("round" in f ? Math.max(m, f.round) : m), detail?.round ?? 0),
    [feed, detail],
  );

  const activeLine = useMemo(() => {
    if (!live || awaiting) return null;
    // `elapsed` isn't read directly, but ticks every second while live — it's
    // what makes the staleness check below actually re-evaluate over time
    // instead of only when a new stream event changes lastEventAt/status.
    void elapsed;
    if (
      stream.status !== "open" &&
      stream.lastEventAt !== null &&
      Date.now() - stream.lastEventAt > STALE_AFTER_MS
    ) {
      return "Intet nyt i et stykke tid — tjekker status…";
    }
    const isTeam = detail?.topology === "team";
    const last = [...feed].reverse().find((f) => f.type === "node" || f.type === "verdict");
    if (!last) return isTeam ? "Arkitekten planlægger" : "Udvikleren skriver";
    if (last.type === "verdict") return isTeam ? "Lead retter til" : "Udvikleren retter til";
    // last.type === "node" — the team graph is architect → worker(s) → lead →
    // critic → (revise) → lead, so a lead node hands off to critic just like a
    // single-topology builder/analyst does.
    if (last.node === "builder" || last.node === "analyst" || last.node === "lead")
      return "Kritikeren gennemgår";
    if (last.node === "architect") return "Udvikleren bygger";
    return `${AGENT[last.node]?.name ?? "Teamet"} arbejder`;
  }, [feed, live, awaiting, detail?.topology, stream.status, stream.lastEventAt, elapsed]);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 2xl:grid-cols-[1fr_384px]">
      {/* ── CENTER · THE DEBATE ── */}
      <section className="relative flex h-full min-h-0 min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {/* Back goes to THIS run's project, not to whatever was last active. */}
            <Link
              href={detail?.projectId ? `/?project=${detail.projectId}` : "/"}
              aria-label={
                detail?.projectName ? `Tilbage til ${detail.projectName}` : "Tilbage"
              }
              className="btn btn-ghost btn-sm btn-circle shrink-0 text-dim hover:text-fg"
            >
              <LuArrowLeft className="h-4 w-4" />
            </Link>
            <p className="flex min-w-0 items-center gap-1.5 text-sm">
              {detail?.projectId && detail.projectName && (
                <>
                  <Link
                    href={`/?project=${detail.projectId}`}
                    className="shrink-0 max-w-[14rem] truncate text-dim transition hover:text-fg"
                  >
                    {detail.projectName}
                  </Link>
                  <span className="shrink-0 text-dim/50">/</span>
                </>
              )}
              <span className="truncate font-medium text-fg/90">
                {detail?.task ?? "Indlæser…"}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {traceUrl && (
              <a
                href={traceUrl}
                target="_blank"
                rel="noreferrer"
                title="Åbn LangSmith-traces"
                className="inline-flex items-center gap-1 text-dim transition hover:text-fg"
              >
                <LuActivity className="h-3.5 w-3.5" /> Traces
              </a>
            )}
            {live && <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-builder" />}
            <span className={`uppercase tracking-[0.18em] ${STATUS_LABEL[status]?.cls ?? "text-dim"}`}>
              {STATUS_LABEL[status]?.text ?? status}
            </span>
            {live && stream.status !== "open" && (
              <span className="text-warning">
                ·{" "}
                {stream.status === "failed"
                  ? "forbindelse afbrudt"
                  : stream.status === "retrying"
                    ? "genopretter forbindelse…"
                    : "forbinder…"}
              </span>
            )}
          </div>
        </header>

        {detail?.topology && (
          <RouterBar
            topology={detail.topology}
            reason={detail.routerReason}
            rerunning={rerunning}
            onOverride={rerunAs}
          />
        )}

        {/* The decision lives in the main column at every width — it used to sit
            in the inspector, which only became a static panel at 2xl, so on a
            normal laptop the run's whole point was hidden behind an edge tab. */}
        {awaiting && (
          <GateBar
            verdict={latestVerdict?.v ?? null}
            deciding={deciding}
            armed={armed}
            onDisarm={() => setArmed(null)}
            onDecide={decide}
          />
        )}

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-3xl space-y-1">
            <Transcript feed={feed} streamStatus={stream.status} onRetry={stream.reconnect} />
            {streaming && <StreamingBubble node={streaming.node} content={streaming.content} />}
            {!streaming && activeLine && <ActiveIndicator label={activeLine} />}
            {awaiting && <div ref={gateRef} className="h-px" />}
          </div>
        </div>

        {!atBottom && (
          <button
            onClick={() => {
              setAtBottom(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
            className="btn btn-sm btn-primary absolute bottom-5 left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-lg"
          >
            Nyeste <LuArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
      </section>

      {/* ── RIGHT · INSPECTOR (static column on lg, slide-over behind an edge tab on smaller) ── */}
      {/* Edge tab — pulls the inspector out without pushing the center; hidden on lg and while open. */}
      {!inspectorOpen && (
        <button
          onClick={() => setInspectorOpen(true)}
          aria-label="Åbn inspector"
          className="fixed right-0 top-1/2 z-30 flex -translate-y-1/2 items-center rounded-l-box border border-r-0 border-line bg-panel py-4 pl-1.5 pr-1 text-dim shadow-lg transition hover:text-fg 2xl:hidden"
        >
          <LuChevronLeft className="h-5 w-5" />
          {awaiting && (
            <span className="pulse-dot absolute -left-1 top-1.5 h-2 w-2 rounded-full bg-warning" />
          )}
        </button>
      )}
      {inspectorOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 2xl:hidden"
          onClick={() => setInspectorOpen(false)}
        />
      )}
      {/* Close flap — mirrors the open tab, pinned to the panel's left edge. */}
      {inspectorOpen && (
        <button
          onClick={() => setInspectorOpen(false)}
          aria-label="Luk inspector"
          style={{ right: "min(88%, 24rem)" }}
          className="fixed top-1/2 z-40 flex -translate-y-1/2 items-center rounded-l-box border border-r-0 border-line bg-panel py-4 pl-1.5 pr-1 text-dim shadow-lg transition hover:text-fg 2xl:hidden"
        >
          <LuChevronRight className="h-5 w-5" />
        </button>
      )}
      <aside
        className={`fixed inset-y-0 right-0 z-40 flex h-full min-h-0 w-[88%] max-w-sm transform flex-col gap-4 overflow-y-auto border-l border-line bg-panel p-4 transition-transform duration-200 2xl:static 2xl:z-auto 2xl:w-auto 2xl:max-w-none 2xl:translate-x-0 2xl:bg-panel/40 ${
          inspectorOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <ArtifactPanel draft={latestDraft} />
        <RubricPanel verdict={latestVerdict?.v ?? null} round={latestVerdict?.round ?? round} />
        <MetaPanel status={status} round={round} elapsed={elapsed} tokens={tokens} live={live} />
      </aside>
    </div>
  );
}

/* ───────────────────────── center pieces ───────────────────────── */

function Transcript({
  feed,
  streamStatus,
  onRetry,
}: {
  feed: FeedItem[];
  streamStatus: StreamStatus;
  onRetry: () => void;
}) {
  let lastRound = 0;
  const out: React.ReactNode[] = [];
  for (const item of feed) {
    const r = "round" in item ? item.round : lastRound;
    if (r > lastRound) {
      lastRound = r;
      out.push(<RoundDivider key={`r-${r}`} round={r} />);
    }
    out.push(<Turn key={item.key} item={item} />);
  }
  if (feed.length === 0) {
    out.push(
      <div key="empty" className="flex flex-col items-center gap-3 py-10 text-center text-sm text-dim">
        {streamStatus === "failed" ? (
          <>
            <p>Kunne ikke forbinde til strømmen.</p>
            <button onClick={onRetry} className="btn btn-outline btn-sm gap-1.5">
              <LuRefreshCw className="h-3.5 w-3.5" /> Prøv igen
            </button>
          </>
        ) : streamStatus === "retrying" ? (
          <p>Genopretter forbindelse…</p>
        ) : (
          <p>Forbinder til strømmen…</p>
        )}
      </div>,
    );
  }
  return <>{out}</>;
}

function RoundDivider({ round }: { round: number }) {
  return (
    <div className="flex items-center gap-3 py-5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-dim">
        Runde {round}
      </span>
      <span className="sweep h-px flex-1 bg-gradient-to-r from-transparent via-line to-transparent" />
    </div>
  );
}

function Turn({ item }: { item: FeedItem }) {
  if (item.type === "error") {
    return (
      <div className="rise my-2 rounded-box border border-error/40 bg-error/10 px-4 py-3 text-sm text-error">
        {item.message}
      </div>
    );
  }

  if (item.type === "verdict") {
    const meta = AGENT.critic!;
    return (
      <Bubble meta={meta} round={item.round} t={item.t}>
        <div className="flex items-center gap-2">
          <span
            className={`badge badge-sm border-0 font-bold ${item.pass ? "badge-success" : "badge-warning"}`}
          >
            {item.pass ? "BESTÅET" : "REVIDÉR"} · {item.score}
          </span>
          <span className="text-xs text-dim">
            {item.issues.length} {item.issues.length === 1 ? "bemærkning" : "bemærkninger"}
          </span>
        </div>
        {item.issues.length > 0 && (
          <div className="collapse-arrow collapse mt-2 rounded-field border border-line bg-ink/50">
            <input type="checkbox" />
            <div className="collapse-title min-h-0 px-3 py-2 text-sm font-medium text-dim">
              Se {item.issues.length} {item.issues.length === 1 ? "bemærkning" : "bemærkninger"}
            </div>
            <div className="collapse-content px-3 text-sm">
              <ul className="space-y-1 pb-1">
                {item.issues.map((iss, i) => (
                  <li key={i} className="flex gap-2 text-fg/80">
                    <LuX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-critic" />
                    <span>{cleanIssue(iss)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Bubble>
    );
  }

  if (item.type !== "node") return null; // awaiting_human / done are handled elsewhere

  const meta = AGENT[item.node] ?? AGENT.system!;
  const isTool = item.content.startsWith("🔧");
  return (
    <Bubble meta={meta} round={item.round} t={item.t} copy={isTool ? undefined : item.content}>
      {isTool ? (
        <div className="flex items-start gap-2 text-dim">
          <LuWrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <pre className="font-mono whitespace-pre-wrap break-words text-sm leading-relaxed">
            {item.content.replace(/^🔧\s*/, "")}
          </pre>
        </div>
      ) : (
        <Md>{item.content}</Md>
      )}
    </Bubble>
  );
}

function Bubble({
  meta,
  round,
  t,
  copy,
  children,
}: {
  meta: (typeof AGENT)[string];
  round: number;
  t: number;
  copy?: string;
  children: React.ReactNode;
}) {
  const right = meta.side === "right";
  const Icon = meta.Icon;
  return (
    <div className={`group rise flex gap-3 py-2 ${right ? "flex-row-reverse" : ""}`}>
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in oklab, ${meta.color} 14%, var(--color-elev))`, color: meta.color }}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className={`min-w-0 max-w-[88%] ${right ? "items-end text-right" : ""}`}>
        <div className={`mb-1 flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
          <span className="text-xs font-semibold" style={{ color: meta.color }}>
            {meta.name}
          </span>
          <span className="text-[11px] text-dim">runde {round}</span>
          <span className="text-[11px] text-dim/60">{clock(t)}</span>
          {copy && (
            <span className="opacity-0 transition group-hover:opacity-100">
              <CopyMenu content={copy} />
            </span>
          )}
        </div>
        <div className="inline-block rounded-box border border-line bg-elev px-4 py-3 text-left">
          {children}
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({ node, content }: { node: "builder" | "analyst"; content: string }) {
  const meta = AGENT[node]!;
  const Icon = meta.Icon;
  return (
    <div className="flex gap-3 py-2">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in oklab, ${meta.color} 14%, var(--color-elev))`, color: meta.color }}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 max-w-[88%]">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: meta.color }}>
            {meta.name}
          </span>
          <span className="shimmer-text text-[11px]">skriver…</span>
        </div>
        <div className="inline-block rounded-box border border-line bg-elev px-4 py-3 text-left">
          {content ? <Md>{content}</Md> : <span className="text-dim">…</span>}
          <span className="pulse-dot ml-0.5 inline-block h-3.5 w-[3px] translate-y-0.5 rounded-sm bg-fg/70 align-middle" />
        </div>
      </div>
    </div>
  );
}

function ActiveIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-3 pl-10">
      <span className="shimmer-text text-sm font-medium">{label}</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-dim pulse-dot"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </span>
    </div>
  );
}

/* ───────────────────────── inspector panels ───────────────────────── */

function Panel({
  title,
  accent,
  action,
  children,
}: {
  title: string;
  accent?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-box border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.2em]"
          style={{ color: accent ?? "var(--color-dim)" }}
        >
          {title}
        </span>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function ArtifactPanel({ draft }: { draft: { content: string; round: number } | null }) {
  return (
    <Panel title="Resultat" action={draft ? <CopyMenu content={draft.content} /> : undefined}>
      {draft ? (
        <>
          <div className="mb-2 text-[11px] text-dim">opdateret · runde {draft.round}</div>
          <div className="max-h-72 overflow-y-auto rounded-field bg-ink/60 p-3">
            <Md>{draft.content}</Md>
          </div>
        </>
      ) : (
        <div className="space-y-2 py-2">
          <div className="skeleton h-3 w-4/5 bg-elev" />
          <div className="skeleton h-3 w-full bg-elev" />
          <div className="skeleton h-3 w-2/3 bg-elev" />
        </div>
      )}
    </Panel>
  );
}

function RubricPanel({ verdict, round }: { verdict: ApiVerdict | null; round: number }) {
  return (
    <Panel title="Kvalitetskrav" accent="var(--color-critic)">
      {verdict ? (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div
              className="radial-progress text-sm font-bold"
              style={
                {
                  "--value": verdict.score,
                  "--size": "3.6rem",
                  "--thickness": "4px",
                  color: verdict.pass ? "var(--color-success)" : "var(--color-critic)",
                } as React.CSSProperties
              }
              role="progressbar"
            >
              {verdict.score}
            </div>
            <div>
              <span
                className={`badge border-0 font-bold ${verdict.pass ? "badge-success" : "badge-warning"}`}
              >
                {verdict.pass ? "BESTÅET" : "MANGLER"}
              </span>
              <p className="mt-1 text-[11px] text-dim">runde {round}</p>
            </div>
          </div>

          {verdict.criteria && verdict.criteria.length > 0 && (
            <ul className="space-y-1.5">
              {verdict.criteria.map((c, i) => (
                <li
                  key={c.id}
                  className="rise flex items-center gap-2 text-[13px]"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  {c.met ? (
                    <LuCheck className="h-4 w-4 shrink-0 text-success" />
                  ) : (
                    <LuX className="h-4 w-4 shrink-0 text-critic" />
                  )}
                  <span className={c.met ? "text-fg/85" : "text-fg/85"}>{c.label}</span>
                  {c.required && (
                    <span className="rounded bg-elev px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-dim">
                      req
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* A passing verdict's remaining notes are improvements, not blockers —
              labelling them "BLOCKERS ✗" next to a green PASS said two opposite
              things at once. Same list, honest name and tone per outcome. */}
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wide text-dim">
              {verdict.issues.length === 0
                ? "Ingen bemærkninger"
                : verdict.pass
                  ? `Forslag · ${verdict.issues.length}`
                  : `Blokeringer · ${verdict.issues.length}`}
            </p>
            <ul className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
              {verdict.issues.map((iss, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug text-fg/75">
                  {verdict.pass ? (
                    <LuLightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-dim" />
                  ) : (
                    <LuX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-critic" />
                  )}
                  <span className="line-clamp-4">{cleanIssue(iss)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="text-sm text-dim">Venter på kritikerens første vurdering…</p>
      )}
    </Panel>
  );
}

/** The router's topology choice + reason, with an override that re-runs the task. */
function RouterBar({
  topology,
  reason,
  rerunning,
  onOverride,
}: {
  topology: "single" | "team";
  reason: string | null;
  rerunning: boolean;
  onOverride: (t: "single" | "team") => void;
}) {
  const other = topology === "single" ? "team" : "single";
  const label = topology === "team" ? "Team" : "Single";
  const otherLabel = other === "team" ? "team" : "single";
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-elev/30 px-5 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <LuCompass className="h-3.5 w-3.5 shrink-0 text-dim" />
        <span className="shrink-0 text-fg/80">
          Ruter: <span className="font-medium text-fg">{label}</span>
        </span>
        {reason && <span className="truncate text-dim">· {reason}</span>}
      </div>
      <button
        onClick={() => onOverride(other)}
        disabled={rerunning}
        title={`Kør opgaven igen som ${otherLabel}`}
        className="btn btn-ghost btn-xs shrink-0 gap-1 text-dim hover:text-fg disabled:opacity-50"
      >
        <LuRefreshCw className={`h-3 w-3 ${rerunning ? "animate-spin" : ""}`} />
        Kør som {otherLabel}
      </button>
    </div>
  );
}

function MetaPanel({
  status,
  round,
  elapsed,
  tokens,
  live,
}: {
  status: string;
  round: number;
  elapsed: number;
  tokens: number;
  live: boolean;
}) {
  const time = elapsed > 0 ? duration(elapsed) : "—";
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <Panel title="Kørsel">
      <dl className="grid grid-cols-2 gap-3 text-center">
        <Stat label="status" value={STATUS_LABEL[status]?.text ?? status} cls={STATUS_LABEL[status]?.cls} />
        <Stat label="runde" value={String(round)} />
        <Stat label="tokens" value={tok} />
        <Stat label="varighed" value={time} />
      </dl>
    </Panel>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <dd className={`font-mono text-sm font-semibold ${cls ?? "text-fg"}`}>{value}</dd>
      <dt className="mt-0.5 text-[10px] uppercase tracking-wide text-dim">{label}</dt>
    </div>
  );
}

/**
 * The human gate, as a bar at the top of the run — not a panel in the
 * inspector. Everything needed to decide is here: what the critic concluded,
 * a note field, and the three actions the loop actually accepts.
 */
function GateBar({
  verdict,
  deciding,
  armed,
  onDisarm,
  onDecide,
}: {
  verdict: ApiVerdict | null;
  deciding: boolean;
  armed: "approve" | "reject" | null;
  onDisarm: () => void;
  onDecide: (d: "approve" | "reject" | "revise", notes?: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const summary = verdict
    ? verdict.pass
      ? `Kritikeren bestod arbejdet (score ${verdict.score})${
          verdict.issues.length > 0
            ? ` med ${verdict.issues.length} forslag`
            : ""
        }.`
      : `Score ${verdict.score} · ${verdict.issues.length} ${
          verdict.issues.length === 1 ? "blokering" : "blokeringer"
        } tilbage.`
    : "Kørslen er sat på pause og venter på din beslutning.";

  return (
    <div className="shrink-0 border-b border-warning/40 bg-warning/5 px-5 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-warning" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warning">
            Venter på dig
          </span>
          <span className="truncate text-sm text-fg/85">{summary}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Note til teamet (bruges når du reviderer)…"
            className="min-w-0 flex-1 rounded-field border border-line bg-ink/50 px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:border-warning/50 focus:outline-none"
          />
          <button
            onClick={() => onDecide("revise", notes)}
            disabled={deciding || !notes.trim()}
            title={notes.trim() ? "Send noten og kør en runde til" : "Skriv en note først"}
            className="btn btn-warning btn-sm gap-1.5 font-bold"
          >
            <LuRefreshCw className="h-4 w-4" /> Revidér
          </button>
          <button
            onClick={() => onDecide("approve")}
            disabled={deciding}
            className="btn btn-success btn-sm gap-1.5 font-bold"
          >
            {deciding ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <LuCheck className="h-4 w-4" />
            )}
            Godkend <kbd className="kbd kbd-xs opacity-70">A</kbd>
          </button>
          <button
            onClick={() => onDecide("reject")}
            disabled={deciding}
            className="btn btn-outline btn-error btn-sm gap-1.5 font-bold"
          >
            <LuX className="h-4 w-4" /> Afvis <kbd className="kbd kbd-xs opacity-70">R</kbd>
          </button>
        </div>

        {armed && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <LuTriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span>
              Tryk <kbd className="kbd kbd-xs">{armed === "approve" ? "A" : "R"}</kbd> igen for at{" "}
              {armed === "approve" ? "godkende" : "afvise"} — beslutningen kan ikke fortrydes.
            </span>
            <button onClick={onDisarm} className="btn btn-ghost btn-xs text-dim hover:text-fg">
              Fortryd (Esc)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
