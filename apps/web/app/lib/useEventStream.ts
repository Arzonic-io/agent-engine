"use client";

import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "open" | "retrying" | "failed";

interface UseEventStreamOptions<T> {
  /** Called for every parsed message. Parse failures are silently dropped. */
  onEvent: (data: T, raw: MessageEvent) => void;
  /** Fires on every successful (re)connect, before any events arrive. */
  onOpen?: () => void;
  /** Fires whenever the connection drops, before a retry is scheduled/attempted. */
  onTransportError?: () => void;
  /** Max reconnect attempts before giving up and reporting "failed". Default 8 (~90s total). */
  maxRetries?: number;
  /** First retry delay; doubles each attempt up to maxDelayMs. Default 1000ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 20000ms. */
  maxDelayMs?: number;
}

/**
 * A reconnecting EventSource: the browser's native EventSource already
 * auto-retries on a transport error, but every consumer in this app was
 * calling `es.close()` from `onerror`, which permanently disables that retry
 * with nothing put in its place — the root cause of the "stream just hangs
 * forever" bug. This hook owns connection lifecycle only; callers keep their
 * own event-type parsing/domain logic in `onEvent`.
 *
 * Also reconnects proactively on `visibilitychange`/`online` — a backgrounded
 * tab's connection can die silently (OS/browser network suspension, an idle
 * proxy timeout) with no error ever surfacing until the tab is foregrounded
 * again, so returning to the tab is treated as a hint to check right away
 * rather than waiting out the remaining backoff.
 */
export function useEventStream<T>(
  url: string | null,
  opts: UseEventStreamOptions<T>,
): { status: StreamStatus; lastEventAt: number | null; stop: () => void; reconnect: () => void } {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  // Options change every render (inline object/callbacks) but must not
  // retrigger the connection effect — stash the latest in a ref instead.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const esRef = useRef<EventSource | null>(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  // Populated by the effect below; `reconnect()` calls through this ref so
  // there is exactly one connect implementation, not a duplicated copy.
  const connectRef = useRef<() => void>(() => {});

  useEffect(() => {
    stoppedRef.current = false;
    attemptRef.current = 0;

    const clearRetry = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const connect = () => {
      if (stoppedRef.current || !url) return;
      clearRetry();
      esRef.current?.close();
      setStatus((s) => (s === "open" ? s : "connecting"));
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        attemptRef.current = 0;
        setStatus("open");
        setLastEventAt(Date.now());
        optsRef.current.onOpen?.();
      };

      es.onmessage = (e) => {
        setLastEventAt(Date.now());
        let data: T;
        try {
          data = JSON.parse(e.data) as T;
        } catch {
          return;
        }
        optsRef.current.onEvent(data, e);
      };

      es.onerror = () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (stoppedRef.current) return;
        optsRef.current.onTransportError?.();

        const maxRetries = optsRef.current.maxRetries ?? 8;
        if (attemptRef.current >= maxRetries) {
          setStatus("failed");
          return;
        }
        const baseDelayMs = optsRef.current.baseDelayMs ?? 1000;
        const maxDelayMs = optsRef.current.maxDelayMs ?? 20_000;
        const attempt = attemptRef.current++;
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        // Jitter avoids every tab reconnecting in lockstep after a shared outage.
        const jittered = delay * (0.75 + Math.random() * 0.5);
        setStatus("retrying");
        retryTimerRef.current = setTimeout(connect, jittered);
      };
    };

    connectRef.current = connect;
    connect();

    // A dropped connection during a backgrounded tab (or a brief offline blip)
    // may never surface via onerror until much later — check proactively.
    const maybeReconnectNow = () => {
      if (stoppedRef.current) return;
      const es = esRef.current;
      if (!es || es.readyState === EventSource.CLOSED) {
        attemptRef.current = 0;
        connect();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeReconnectNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", maybeReconnectNow);

    return () => {
      stoppedRef.current = true;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", maybeReconnectNow);
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts intentionally read via ref
  }, [url]);

  return {
    status,
    lastEventAt,
    /** Stop reconnecting entirely — call once a definitively terminal event (e.g. "done") arrives. */
    stop: () => {
      stoppedRef.current = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    },
    /** Reset backoff and reconnect immediately — wired to a manual "Retry" affordance. */
    reconnect: () => {
      stoppedRef.current = false;
      attemptRef.current = 0;
      connectRef.current();
    },
  };
}
