"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LuRocket, LuTarget } from "react-icons/lu";
import type { MissionDetail, MissionSummary, Project, RepoInfo } from "@arzonic/agent-client";
import { MISSION_DOT, relTime } from "../lib/format";

export default function MissionsPage() {
  const router = useRouter();
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  // create form
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [criteria, setCriteria] = useState("");
  const [items, setItems] = useState("");
  const [budget, setBudget] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, p, r] = await Promise.all([
          fetch("/api/missions"),
          fetch("/api/projects"),
          fetch("/api/repos"),
        ]);
        if (m.ok) setMissions((await m.json()) as MissionSummary[]);
        if (p.ok) {
          const list = ((await p.json()) as Project[]).filter((x) => x.name !== "Scratch");
          setProjects(list);
          if (list[0]) {
            setProjectId(list[0].id);
            const repo = typeof list[0].settings?.repoPath === "string" ? list[0].settings.repoPath : "";
            setRepoPath(repo as string);
          }
        }
        if (r.ok) setRepos((await r.json()) as RepoInfo[]);
      } catch {
        /* API booting */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // When the chosen project has a bound repo, default to it.
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );
  useEffect(() => {
    const repo =
      typeof selectedProject?.settings?.repoPath === "string"
        ? (selectedProject.settings.repoPath as string)
        : "";
    if (repo) setRepoPath(repo);
  }, [selectedProject]);

  async function create() {
    if (!projectId || !goal.trim() || !repoPath.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const body = {
        projectId,
        goal: goal.trim(),
        repoPath: repoPath.trim(),
        acceptanceCriteria: criteria.split("\n").map((s) => s.trim()).filter(Boolean),
        budget: budget.trim() ? Number(budget) : null,
        items: items
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((title) => ({ title })),
      };
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const mission = (await res.json()) as MissionDetail;
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke oprette missionen");
      setCreating(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="loading loading-spinner loading-md text-dim" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 sm:px-8">
      <div className="mx-auto w-full max-w-3xl pb-20 pt-[6vh]">
        <div className="rise mb-6">
          <p className="mb-2 inline-flex items-center gap-2 text-xs uppercase tracking-[0.35em] text-dim">
            <LuRocket className="h-3.5 w-3.5" /> Missioner
          </p>
          <h1 className="display text-4xl font-extrabold leading-[1.08] tracking-tight">
            Autonome missioner
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-dim">
            Et mål, en backlog teamet selv driver: planlæg → kør → verificér mod repoet → genplanlæg,
            indtil målet er nået eller en governor stopper. Du overvåger asynkront — risiko parkeres til dig.
          </p>
        </div>

        {/* create */}
        <div className="rise rounded-box border border-line bg-panel p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-dim">
              Projekt
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="select select-sm mt-1 w-full border-line bg-elev"
              >
                {projects.length === 0 && <option value="">Opret et projekt først</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-dim">
              Repo (verificeres mod)
              <select
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="select select-sm mt-1 w-full border-line bg-elev"
              >
                <option value="">Vælg repo…</option>
                {repos.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 block text-xs text-dim">
            Mål
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="F.eks. Byg en webshop med katalog, kurv, checkout og tests."
              className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:outline-none"
            />
          </label>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-dim">
              Acceptkriterier (én pr. linje)
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                rows={3}
                placeholder={"build grøn\ntests består"}
                className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:outline-none"
              />
            </label>
            <label className="text-xs text-dim">
              Start-backlog (én opgave pr. linje, valgfri)
              <textarea
                value={items}
                onChange={(e) => setItems(e.target.value)}
                rows={3}
                placeholder={"Opsæt produktmodel\nByg kurv"}
                className="mt-1 w-full resize-none rounded-field border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-dim/50 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <label className="text-xs text-dim">
              Token-budget (valgfri)
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                placeholder="ubegrænset"
                className="input input-sm ml-2 w-32 border-line bg-elev"
              />
            </label>
            <button
              onClick={() => void create()}
              disabled={creating || !projectId || !goal.trim() || !repoPath.trim()}
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

        {/* list */}
        <h2 className="mt-8 mb-2 text-[11px] uppercase tracking-[0.28em] text-dim">Kørende & tidligere</h2>
        {missions.length === 0 ? (
          <p className="rounded-box border border-line bg-panel/50 px-4 py-8 text-center text-sm text-dim">
            Ingen missioner endnu — start din første ovenfor.
          </p>
        ) : (
          <ul className="space-y-2">
            {missions.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/missions/${m.id}`}
                  className="block rounded-box border border-line bg-panel px-4 py-3 transition hover:bg-elev/60"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${MISSION_DOT[m.status] ?? "bg-dim"} ${
                        m.status === "running" ? "pulse-dot" : ""
                      }`}
                    />
                    <span className="truncate text-sm font-medium text-fg/90">{m.goal}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-4 text-[11px] text-dim">
                    <span className="uppercase tracking-wide">{m.status}</span>
                    <span>·</span>
                    <span>{m.spentTokens.toLocaleString("da-DK")} tokens</span>
                    <span>·</span>
                    <span>{relTime(m.createdAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
