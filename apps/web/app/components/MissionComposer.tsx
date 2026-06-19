"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LuTarget, LuTriangleAlert, LuUsers } from "react-icons/lu";
import type { MissionDetail } from "@arzonic/agent-client";
import {
  TEAM_ROLES,
  TeamModelPicker,
  selectionToRoleModels,
  teamCount,
  type TeamSelection,
} from "./TeamModelPicker";

/**
 * Mission creation inside a project. A mission inherits the project's repo
 * (the truth source the Verifier checks against), so it can only start once the
 * project has a repo bound — otherwise there is nothing to verify "done" against.
 */
export function MissionComposer({
  projectId,
  repoPath,
}: {
  projectId: string;
  repoPath: string;
}) {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [items, setItems] = useState("");
  const [budget, setBudget] = useState("");
  const [team, setTeam] = useState<TeamSelection>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noRepo = !repoPath.trim();
  const pinned = teamCount(team);

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
          items: items
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title })),
          roleModels: selectionToRoleModels(team),
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

      <details className="group mt-3 rounded-field border border-line bg-elev/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-dim">
          <LuUsers className="h-3.5 w-3.5" />
          <span className="font-medium text-fg">Team-modeller</span>
          <span className="text-dim/70">
            {pinned > 0 ? `${pinned} rolle${pinned > 1 ? "r" : ""} tilpasset` : "vælg model pr. agent (valgfri)"}
          </span>
          <span className="ml-auto text-dim/50 transition group-open:rotate-180">⌄</span>
        </summary>
        <div className="space-y-1.5 border-t border-line px-3 py-3">
          <p className="mb-2 text-[11px] leading-relaxed text-dim/70">
            Hver agent bruger <span className="text-fg">Standard</span> (den globale default) med mindre du vælger
            en anden her. Gemmes på missionen. Lad model-feltet stå tomt for providerens default.
          </p>
          <TeamModelPicker roles={TEAM_ROLES} value={team} onChange={setTeam} />
        </div>
      </details>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-xs text-dim">
          Token-budget
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="ubegrænset"
            className="input input-sm w-32 border-line bg-elev"
          />
        </label>
        <button
          onClick={() => void start()}
          disabled={creating || noRepo || !goal.trim()}
          className="btn btn-primary display gap-2 font-bold normal-case"
        >
          {creating ? (
            <>
              <span className="loading loading-spinner loading-xs" /> Starter…
            </>
          ) : (
            <>
              <LuTarget className="h-4 w-4" /> Start mission
            </>
          )}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </div>
  );
}
