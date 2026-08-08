"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  LuCircleCheck,
  LuCircleDot,
  LuSettings2,
  LuTarget,
  LuTriangleAlert,
  LuUsers,
  LuX,
} from "react-icons/lu";
import type { GitHubIssue, MissionDetail } from "@arzonic/agent-client";
import { GitHubIssuePicker } from "./GitHubIssuePicker";
import {
  TEAM_ROLES,
  TeamModelPicker,
  selectionToRoleModels,
  type TeamSelection,
} from "./TeamModelPicker";

/** Extract GitHub task-list checkboxes (`- [ ] …`) from an issue body as acceptance criteria. */
function criteriaFromIssueBody(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s*\[[ xX]\]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s*\[[ xX]\]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Realistic token-budget rungs (hard ceiling per mission). Free-text invited
 * unrealistic values (7-digit typos or "500" killing the run after one item);
 * a select keeps the rail meaningful. 100k ≈ a solid evening run; 300k is the
 * deliberate max — beyond that, split the goal into flere missioner.
 */
const BUDGET_OPTIONS: { value: string; label: string }[] = [
  { value: "25000", label: "25.000 tokens · hurtigt forsøg" },
  { value: "50000", label: "50.000 tokens · lille mission" },
  { value: "100000", label: "100.000 tokens · aftenkørsel" },
  { value: "200000", label: "200.000 tokens · natkørsel" },
  { value: "300000", label: "300.000 tokens · maks" },
  { value: "", label: "Ubegrænset (kun deadline/governors)" },
];

/**
 * Mission creation inside a project. A mission inherits the project's repo
 * (the truth source the Verifier checks against), so it can only start once the
 * project has a repo bound — otherwise there is nothing to verify "done" against.
 */
export function MissionComposer({
  projectId,
  repoPath,
  githubRepo = null,
  allowedChecks = [],
  defaultChecks = [],
}: {
  projectId: string;
  repoPath: string;
  /** The project's bound GitHub repo (owner/repo), enabling the "start from an issue" picker. */
  githubRepo?: { owner: string; repo: string } | null;
  /** Named pnpm scripts a mission may verify with (server allowlist). */
  allowedChecks?: string[];
  /** The set pre-selected when the composer opens (the server's MISSION_CHECKS default). */
  defaultChecks?: string[];
}) {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  // The GitHub issue this mission is started from (its PR later `Closes #n`). Null = none.
  const [issueNumber, setIssueNumber] = useState<number | null>(null);
  const [items, setItems] = useState("");
  const [budget, setBudget] = useState("100000");
  const [deadline, setDeadline] = useState("");
  // "Done" for this mission = these checks pass. Pre-select the server default,
  // constrained to the allowlist. The engine is only as strong as these checks, so
  // picking the ones the target repo actually has is what makes "green" mean something.
  const [checks, setChecks] = useState<Set<string>>(
    () => new Set(defaultChecks.filter((c) => allowedChecks.includes(c))),
  );
  const [team, setTeam] = useState<TeamSelection>({});
  // The whole team is active by default — every member works the mission unless you
  // turn one off. An active-but-uncustomised role inherits the default team (Settings
  // / project), so this never silently overrides your default models with Mistral.
  const [activeRoles, setActiveRoles] = useState<Set<string>>(
    () => new Set(TEAM_ROLES.map((r) => r.key)),
  );
  const [showTeamConfig, setShowTeamConfig] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noRepo = !repoPath.trim();

  /** Toggle a role on/off. Off clears its model override. The config panel only opens via the Konfigurér button. */
  function toggleRole(key: string) {
    const next = new Set(activeRoles);
    if (next.has(key)) {
      next.delete(key);
      setTeam((t) => {
        const copy = { ...t };
        delete copy[key];
        return copy;
      });
    } else {
      next.add(key);
    }
    setActiveRoles(next);
  }

  function toggleCheck(name: string) {
    setChecks((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Prefill the mission from a GitHub issue: goal ← title, criteria ← task-list, link the number. */
  function applyIssue(issue: GitHubIssue) {
    setGoal(issue.title);
    const crit = criteriaFromIssueBody(issue.body);
    if (crit.length > 0) setCriteria(crit.join("\n"));
    setIssueNumber(issue.number);
  }

  async function start() {
    if (!goal.trim() || noRepo || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          goal: goal.trim(),
          repoPath,
          acceptanceCriteria: criteria.split("\n").map((s) => s.trim()).filter(Boolean),
          budget: budget.trim() ? Number(budget) : null,
          // Wall-clock "stop by" rail (blocker 2). datetime-local is local time with
          // no zone; toISOString normalises it to the UTC ISO the API expects. Empty
          // ⇒ no deadline (only budget / no-progress / iterations bound the run).
          deadline: deadline.trim() ? new Date(deadline).toISOString() : null,
          items: items
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title })),
          roleModels: selectionToRoleModels(team),
          // Which checks make an item "done". Empty ⇒ server's MISSION_CHECKS default.
          checks: [...checks],
          // The originating GitHub issue, if any — the PR later `Closes #n`.
          issueNumber,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const mission = (await res.json()) as MissionDetail;
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke starte missionen");
      setCreating(false);
    }
  }

  return (
    <div
      className="rise rounded-box border border-line bg-panel p-4 shadow-2xl shadow-black/30"
      style={{ animationDelay: "60ms" }}
    >
      {noRepo && (
        <div className="mb-3 flex items-start gap-2 rounded-field border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            En mission verificerer mod projektets repo. Vælg et repo for projektet ovenfor for at
            kunne starte en mission.
          </span>
        </div>
      )}

      {/* Team at the top — which members work this mission (moved off the project header). */}
      <div className="mb-3 rounded-field border border-line bg-elev/40 px-3 py-2.5">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <LuUsers className="h-3.5 w-3.5 text-dim" />
          <span className="font-medium text-fg">Team</span>
          <span className="text-dim/70">hele teamet er aktivt — slå en stilling fra du ikke vil bruge, eller giv en sin egen model</span>
          <button
            type="button"
            onClick={() => setShowTeamConfig((s) => !s)}
            disabled={activeRoles.size === 0}
            title="Redigér modeller for de aktive stillinger"
            className={`ml-auto inline-flex items-center gap-1 rounded-field px-2 py-1 text-[11px] transition disabled:opacity-40 ${
              showTeamConfig ? "bg-elev text-fg" : "text-dim hover:bg-elev hover:text-fg"
            }`}
          >
            <LuSettings2 className="h-3.5 w-3.5" /> Konfigurér
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {TEAM_ROLES.map((r) => {
            const on = activeRoles.has(r.key);
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => toggleRole(r.key)}
                title={r.hint}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                  on
                    ? "border-line bg-elev text-fg"
                    : "border-transparent bg-elev/30 text-dim opacity-60 hover:opacity-100"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${on ? r.dot : "bg-dim"}`} />
                {r.label}
              </button>
            );
          })}
        </div>

        {showTeamConfig && activeRoles.size > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-2 text-[11px] leading-relaxed text-dim/70">
              Vælg provider — og evt. en bestemt model — for de aktive stillinger. Resten arver den globale
              default. Lad model-feltet stå tomt for providerens default.
            </p>
            <TeamModelPicker
              roles={TEAM_ROLES.filter((r) => activeRoles.has(r.key))}
              value={team}
              onChange={setTeam}
            />
          </div>
        )}
      </div>

      {/* Start from a GitHub issue: prefill goal/criteria and link it (PR `Closes #n`). */}
      {githubRepo && (
        <div className="mb-3">
          <GitHubIssuePicker
            owner={githubRepo.owner}
            repo={githubRepo.repo}
            selectedNumber={issueNumber}
            onSelect={applyIssue}
          />
          {issueNumber != null && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-dim">
              <LuCircleDot className="h-3 w-3 text-success" />
              <span>
                Linket til issue <span className="font-mono text-fg/80">#{issueNumber}</span> —
                PR&apos;en lukker det ved merge.
              </span>
              <button
                type="button"
                onClick={() => setIssueNumber(null)}
                className="inline-flex items-center gap-0.5 text-dim hover:text-fg"
                title="Fjern issue-linket"
              >
                <LuX className="h-3 w-3" /> fjern
              </button>
            </div>
          )}
        </div>
      )}

      <label className="block text-xs text-dim">
        Mål
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder="Hvad skal missionen opnå? F.eks. Byg katalog, kurv og checkout med tests, der består."
          className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-[15px] leading-relaxed text-fg placeholder:text-dim/50 focus:outline-none"
        />
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-dim">
          Acceptkriterier <span className="text-dim/60">(én pr. linje)</span>
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={3}
            placeholder={"build grøn\ntests består"}
            className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:outline-none"
          />
        </label>
        <label className="text-xs text-dim">
          Start-backlog <span className="text-dim/60">(én opgave pr. linje, valgfri)</span>
          <textarea
            value={items}
            onChange={(e) => setItems(e.target.value)}
            rows={3}
            placeholder={"Opsæt produktmodel\nByg kurv"}
            className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:outline-none"
          />
        </label>
      </div>

      {allowedChecks.length > 0 && (
        <div className="mt-3 rounded-field border border-line bg-elev/40 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <LuCircleCheck className="h-3.5 w-3.5 text-dim" />
            <span className="font-medium text-fg">Verifikation</span>
            <span className="text-dim/70">
              et item er først “færdigt” når disse checks består — vælg dem dit repo faktisk har
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {allowedChecks.map((c) => {
              const on = checks.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCheck(c)}
                  title={`pnpm run ${c}`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${
                    on
                      ? "border-builder/40 bg-builder/15 text-fg"
                      : "border-transparent bg-elev/30 text-dim opacity-60 hover:opacity-100"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-builder" : "bg-dim"}`} />
                  {c}
                </button>
              );
            })}
          </div>
          {checks.size === 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
              <LuTriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              Ingen checks valgt — “færdig” hviler så kun på kritikeren, ikke rigtige checks.
            </p>
          )}
        </div>
      )}

      {/* Rails: budget + deadline side by side, 50/50 — the two ways a run is bounded. */}
      <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
        <label className="block text-xs text-dim">
          Token-budget <span className="text-dim/60">(hårdt loft)</span>
          <select
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="select select-sm mt-1 w-full border-line bg-elev"
          >
            {BUDGET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-dim">
          Deadline <span className="text-dim/60">(stop senest)</span>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="input input-sm mt-1 w-full border-line bg-elev"
          />
        </label>
      </div>

      <div className="mt-3 flex justify-end">
        <div className={creating || noRepo || !goal.trim() ? "inline-block" : "aura aura-dual text-primary"}>
          <button
            onClick={() => void start()}
            disabled={creating || noRepo || !goal.trim()}
            className="btn btn-soft"
          >
            {creating ? (
              <span className="skeleton skeleton-text">Starter missionen…</span>
            ) : (
              <>
                <LuTarget className="h-4 w-4" /> Start mission
              </>
            )}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </div>
  );
}
