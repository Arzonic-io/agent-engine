"use client";

import { useEffect, useState, type ReactNode } from "react";
import { LuActivity, LuTriangleAlert } from "react-icons/lu";
import type { ApiUsageSummary } from "@arzonic/agent-client";

/** Danish names for the roles — the team picker's names where they overlap. */
const ROLE_LABEL: Record<string, string> = {
  survey: "Kortlægning",
  decompose: "Planlægger",
  implementer: "Udvikler",
  missionCritic: "Kritiker",
  tester: "Tester",
  replan: "Koordinator",
  rubricAssessor: "Done-dom",
  router: "Router",
  architect: "Arkitekt",
  proposeCriteria: "Kriterieforslag",
  builder: "Builder",
  critic: "Kritiker",
  worker: "Worker",
  lead: "Lead",
  analyst: "Analytiker",
  unrecorded: "Ikke gemt",
  unknown: "Ukendt rolle",
};

const STATUS_LABEL: Record<string, string> = {
  done: "færdig",
  failed: "fejlet",
  blocked_needs_human: "afventer dig",
  in_progress: "i gang",
  todo: "i kø",
};

/** Why a "?" is a "?" — every one carries it, for hover and screen readers. */
const UNKNOWN_HINT = "Ukendt — kaldene mangler forbrugstal eller kendt pris";

const fmt = (n: number) => n.toLocaleString("da-DK");
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * A token figure that the unmeasured calls may leave short: "?" when nothing is known, "≥ n" when
 * only part is. Unmeasured = unknown (the provider reported no usage) + dropped (lost before the
 * ledger). Failed calls are left out, as in the API's costComplete: they are assumed unbilled.
 */
const tokensText = (n: number, unmeasured: number) =>
  unmeasured === 0 ? fmt(n) : n === 0 ? "?" : `≥ ${fmt(n)}`;

/** The same for a price, which a call with no known price also leaves short — `gap` counts all three kinds. */
const priceText = (usdValue: number, gap: number) =>
  gap === 0 ? usd(usdValue) : usdValue === 0 ? "?" : `≥ ${usd(usdValue)}`;

/** A "?" that says why. */
function Unknown() {
  return (
    <span title={UNKNOWN_HINT}>
      ?<span className="sr-only"> {UNKNOWN_HINT}</span>
    </span>
  );
}

/** A figure from tokensText / priceText — a bare "?" gets its explanation. */
function Figure({ text }: { text: string }) {
  return text === "?" ? <Unknown /> : <>{text}</>;
}

/** "n tokens", with the "≥" or "?" the unmeasured calls call for. */
function Tokens({ n, unmeasured }: { n: number; unmeasured: number }) {
  return (
    <>
      <Figure text={tokensText(n, unmeasured)} /> tokens
    </>
  );
}

function Heading({ total }: { total?: ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-dim">
      <LuActivity className="h-3.5 w-3.5" />
      Forbrug pr. rolle
      {total && <span className="ml-auto font-mono normal-case tracking-normal text-fg/70">{total}</span>}
    </h2>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 rounded-field border border-line bg-elev px-2.5 py-1">
      <span className="whitespace-nowrap font-mono font-semibold text-fg/90">{value}</span>
      {sub && <span className="whitespace-nowrap font-mono text-dim">{sub}</span>}
      <span className="text-dim">{label}</span>
    </span>
  );
}

/**
 * What the mission's model calls cost: per role, the most expensive items, and
 * per finished item — waste and shared work included. Reads the usage ledger;
 * refreshes every 15 s while the mission runs.
 */
export function MissionUsagePanel({ missionId, active }: { missionId: string; active: boolean }) {
  const [data, setData] = useState<ApiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/missions/${missionId}/usage`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ApiUsageSummary;
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = active ? setInterval(() => void load(), 15_000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [missionId, active]);

  if (!data) {
    if (!error) return null;
    return (
      <section className="mt-6">
        <Heading />
        <p className="text-xs text-error">Forbruget kunne ikke hentes ({error}).</p>
      </section>
    );
  }

  const { totals, byRole, byItem, outcome } = data;
  if (totals.calls === 0) {
    return (
      <section className="mt-6">
        <Heading />
        <p className="rounded-box border border-line bg-panel px-4 py-3 text-xs text-dim">
          Ingen målte modelkald endnu. Målingen tæller kun kald, efter den blev slået til, så ældre missioner står tomme.
        </p>
      </section>
    );
  }

  const approx = data.costComplete ? "≈" : "≥";
  const totalUnmeasured = totals.unknownCalls + totals.droppedCalls;
  const top = Math.max(1, ...byRole.map((r) => r.billable));
  const expensive = byItem.filter((i) => i.calls > 0).slice(0, 5);
  const gaps = [
    totals.unknownCalls > 0 ? `${fmt(totals.unknownCalls)} kald uden forbrugstal` : null,
    totals.droppedCalls > 0 ? `${fmt(totals.droppedCalls)} kald kunne ikke gemmes` : null,
    totals.unpricedCalls > 0 ? `${fmt(totals.unpricedCalls)} kald uden kendt pris` : null,
  ].filter((g): g is string => g !== null);
  const counted = data.budgetCounted;

  return (
    <section className="mt-6">
      <Heading total={!data.costComplete && totals.costUsd === 0 ? <Unknown /> : `${approx} ${usd(totals.costUsd)}`} />
      <div className="rise rounded-box border border-line bg-panel px-4 py-3">
        {outcome && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Stat
              label="pr. færdigt item"
              value={
                outcome.billablePerDoneItem === null ? "–" : <Tokens n={outcome.billablePerDoneItem} unmeasured={totalUnmeasured} />
              }
              sub={
                outcome.costPerDoneItemUsd === null ? undefined : outcome.costPerDoneItemUsd === 0 && !data.costComplete ? (
                  <Unknown />
                ) : (
                  `${approx} ${usd(outcome.costPerDoneItemUsd)}`
                )
              }
            />
            <Stat
              label="på items, der ikke blev færdige"
              value={<Tokens n={outcome.billableOnOther} unmeasured={totalUnmeasured} />}
              sub={totals.billable > 0 ? `${Math.round((outcome.billableOnOther / totals.billable) * 100)} %` : undefined}
            />
            <Stat
              label="fælles (kortlægning, plan, done-dom)"
              value={<Tokens n={outcome.billableShared} unmeasured={totalUnmeasured} />}
            />
          </div>
        )}

        <table className="w-full text-xs">
          <thead className="text-left text-[10px] uppercase tracking-[0.2em] text-dim">
            <tr>
              <th className="py-1 font-normal">Rolle</th>
              <th className="py-1 text-right font-normal">Kald</th>
              <th className="py-1 pl-3 text-right font-normal">Tokens</th>
              <th className="w-1/4 py-1 font-normal">
                <span className="sr-only">Andel</span>
              </th>
              <th className="py-1 text-right font-normal">Pris</th>
            </tr>
          </thead>
          <tbody>
            {byRole.map((r) => (
              <tr key={r.role} className="border-t border-line/60">
                <td className="py-1.5 pr-2 text-fg/90">
                  {ROLE_LABEL[r.role] ?? r.role}
                  {r.models.length > 0 && (
                    <span className="ml-1.5 font-mono text-[10px] text-dim">{r.models.join(", ")}</span>
                  )}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-fg/80">{fmt(r.calls)}</td>
                <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono tabular-nums text-fg/80">
                  <Figure text={tokensText(r.billable, r.unknownCalls + r.droppedCalls)} />
                </td>
                <td className="px-3 py-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-elev">
                    <div className="h-full rounded-full bg-builder" style={{ width: `${(r.billable / top) * 100}%` }} />
                  </div>
                </td>
                <td className="whitespace-nowrap py-1.5 text-right font-mono tabular-nums text-dim">
                  <Figure text={priceText(r.costUsd, r.unknownCalls + r.droppedCalls + r.unpricedCalls)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {expensive.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-dim">Dyreste items</p>
            <ul className="space-y-1 text-xs">
              {expensive.map((i) => (
                <li key={i.itemId} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-fg/80">{i.title}</span>
                  <span className="shrink-0 font-mono tabular-nums text-dim">
                    {STATUS_LABEL[i.status] ?? i.status} · {i.attempts} forsøg ·{" "}
                    {/* an item has no counters: calls but no tokens means they were never reported */}
                    <Figure text={i.calls > 0 && i.billable === 0 ? "?" : fmt(i.billable)} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {counted !== null && (
          <p className="mt-3 text-[11px] text-dim">
            Budgettet har talt {fmt(counted)} tokens · målt <Figure text={tokensText(totals.billable, totalUnmeasured)} />.
            {totalUnmeasured === 0 && totals.billable > counted && " Forskellen er kald, budgettet ikke tæller med, fx kortlægningen og løkker, der fejlede."}
            {totalUnmeasured === 0 && totals.billable < counted && " Budgettet har talt mere, end vi har målt — typisk fordi missionen startede, før målingen blev slået til."}
          </p>
        )}
        {gaps.length > 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-warning">
            <LuTriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {gaps.join(" · ")}. Tallene er derfor et minimum.
          </p>
        )}
      </div>
    </section>
  );
}
