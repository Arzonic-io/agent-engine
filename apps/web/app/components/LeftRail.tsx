"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LuFolderGit2, LuFolderPlus, LuRocket, LuTrash2 } from "react-icons/lu";
import type { MissionSummary, Project, RecentTask } from "@arzonic/agent-client";
import {
  getActiveProject,
  requestNewProject,
  setActiveProject,
  useActiveProject,
} from "../lib/activeProject";
import { MISSION_DOT, relShort, STATUS_DOT } from "../lib/format";

type Filter = "all" | "running" | "awaiting_human" | "done";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "running", label: "Live" },
  { key: "awaiting_human", label: "Gate" },
  { key: "done", label: "Færdig" },
];

function repoName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function LeftRail({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const [activeProject] = useActiveProject();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<RecentTask[]>([]);
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [menu, setMenu] = useState<{ x: number; y: number; task: RecentTask } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const activeId = pathname.startsWith("/runs/") ? pathname.split("/")[2] : null;
  const activeMissionId = pathname.startsWith("/missions/") ? pathname.split("/")[2] : null;

  /** projectId → project name, for labelling missions (which carry only the id). */
  const projectName = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? "Projekt";
  }, [projects]);

  // ── poll projects; keep an active project selected (for the composer) ──
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok || !alive) return;
        const list = ((await res.json()) as Project[]).filter((p) => p.name !== "Scratch");
        setProjects(list);
        const cur = getActiveProject();
        if ((!cur || !list.some((p) => p.id === cur)) && list[0]) setActiveProject(list[0].id);
      } catch {
        /* best-effort */
      }
    };
    void load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ── poll ALL tasks across every project ──
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/tasks");
        if (res.ok && alive) setTasks((await res.json()) as RecentTask[]);
      } catch {
        /* best-effort */
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ── poll ALL missions across every project ──
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/missions");
        if (res.ok && alive) setMissions((await res.json()) as MissionSummary[]);
      } catch {
        /* best-effort */
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    if (filter === "done")
      return tasks.filter((t) => t.status === "accepted" || t.status === "rejected");
    return tasks.filter((t) => t.status === filter);
  }, [tasks, filter]);

  const awaitingCount = useMemo(
    () => tasks.filter((t) => t.status === "awaiting_human").length,
    [tasks],
  );

  const deleteTask = async (task: RecentTask) => {
    setMenu(null);
    setDeleting(task.id);
    setTasks((prev) => prev.filter((t) => t.id !== task.id)); // optimistic
    try {
      await fetch(`/api/runs/${task.id}`, { method: "DELETE" });
    } catch {
      /* ignore — list refreshes on next poll */
    } finally {
      setDeleting(null);
      if (activeId === task.id) router.push("/");
    }
  };

  const switchProject = (id: string) => {
    setActiveProject(id);
    onNavigate?.();
    router.push("/");
  };

  const newProject = () => {
    requestNewProject();
    onNavigate?.();
    router.push("/");
  };

  // close the context menu on any outside click / escape / scroll
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // J / K navigation between tasks
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (filtered.length === 0) return;
      const idx = filtered.findIndex((t) => t.id === activeId);
      const next = e.key === "j" ? Math.min(filtered.length - 1, idx + 1) : Math.max(0, idx - 1);
      const target = filtered[next === -1 ? 0 : next];
      if (target) router.push(`/runs/${target.id}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, activeId, router]);

  return (
    <aside className="flex h-full w-full flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <span className="pulse-dot inline-block h-2.5 w-2.5 rounded-full bg-builder" />
        <span className="font-display text-base font-extrabold tracking-tight">Multi Agent Team</span>
      </div>

      {/* New project — pinned at the top */}
      <div className="px-2 pb-2">
        <button
          onClick={newProject}
          className="btn btn-primary w-full gap-1.5 font-bold normal-case"
        >
          <LuFolderPlus className="h-4 w-4" /> Nyt projekt
        </button>
      </div>

      {/* ── Projects ── */}
      <div className="px-4 pb-1.5">
        <span className="text-[11px] uppercase tracking-[0.28em] text-dim">Projekter</span>
      </div>

      <div className="max-h-[32%] overflow-y-auto px-2 pb-1">
        {projects.length === 0 ? (
          <p className="px-3 py-3 text-center text-xs text-dim">Ingen projekter endnu.</p>
        ) : (
          <ul className="space-y-0.5">
            {projects.map((p) => {
              const active = p.id === activeProject;
              const repo =
                typeof p.settings?.repoPath === "string" ? (p.settings.repoPath as string) : "";
              const remembered = p.stats?.memoryCount ?? 0;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => switchProject(p.id)}
                    className={`block w-full rounded-field px-3 py-2 text-left transition ${
                      active ? "bg-elev" : "hover:bg-elev/60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-builder" : "bg-dim"}`}
                      />
                      <span className="truncate text-sm text-fg/90">{p.name}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[11px] text-dim">
                      {repo && (
                        <>
                          <LuFolderGit2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{repoName(repo)}</span>
                          <span>·</span>
                        </>
                      )}
                      <span className="shrink-0">{remembered > 0 ? `${remembered} husket` : "ny"}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Recent tasks (all projects) ── */}
      <div className="flex items-center justify-between border-t border-line px-4 pb-1.5 pt-3">
        <span className="text-[11px] uppercase tracking-[0.28em] text-dim">Seneste opgaver</span>
        {awaitingCount > 0 && (
          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
            {awaitingCount} ved gaten
          </span>
        )}
      </div>
      <div className="flex gap-1 px-4 pb-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-1 rounded-field px-2 py-1 text-xs transition ${
              filter === f.key ? "bg-elev text-fg" : "text-dim hover:text-fg"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="max-h-60 overflow-y-auto px-2 py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-dim">Ingen opgaver endnu.</p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((t) => {
              const active = t.id === activeId;
              return (
                <li key={t.id}>
                  <Link
                    href={`/runs/${t.id}`}
                    onClick={onNavigate}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, task: t });
                    }}
                    className={`block rounded-field px-3 py-2.5 transition ${
                      active ? "bg-elev" : "hover:bg-elev/60"
                    } ${deleting === t.id ? "pointer-events-none opacity-40" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? "bg-dim"} ${
                          t.status === "running" ? "pulse-dot" : ""
                        }`}
                      />
                      <span className="truncate text-sm text-fg/90">{t.task}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-[11px] text-dim">
                      <span className="truncate text-fg/55">{t.projectName}</span>
                      <span>·</span>
                      <span className="shrink-0 uppercase tracking-wide">
                        {t.status.replace("_", " ")}
                      </span>
                      <span>·</span>
                      <span className="shrink-0">{relShort(t.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Recent missions (all projects) ── */}
      {missions.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 border-t border-line px-4 pb-1.5 pt-3">
            <LuRocket className="h-3.5 w-3.5 text-dim" />
            <span className="text-[11px] uppercase tracking-[0.28em] text-dim">Seneste missioner</span>
          </div>
          <div className="max-h-60 overflow-y-auto px-2 pb-1">
            <ul className="space-y-0.5">
              {missions.map((m) => {
                const active = m.id === activeMissionId;
                return (
                  <li key={m.id}>
                    <Link
                      href={`/missions/${m.id}`}
                      onClick={onNavigate}
                      className={`block rounded-field px-3 py-2.5 transition ${
                        active ? "bg-elev" : "hover:bg-elev/60"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${MISSION_DOT[m.status] ?? "bg-dim"} ${
                            m.status === "running" ? "pulse-dot" : ""
                          }`}
                        />
                        <span className="truncate text-sm text-fg/90">{m.goal}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-[11px] text-dim">
                        <span className="truncate text-fg/55">{projectName(m.projectId)}</span>
                        <span>·</span>
                        <span className="shrink-0 uppercase tracking-wide">{m.status}</span>
                        <span>·</span>
                        <span className="shrink-0">{relShort(m.createdAt)}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      <div className="min-h-4 flex-1" />

      <div className="flex items-center gap-2.5 border-t border-line px-5 py-3.5 text-sm text-dim">
        <Image src="/image.png" alt="Arzonic" width={24} height={24} className="rounded-sm opacity-80" />
        <span className="opacity-70">Arzonic · internt værktøj</span>
      </div>

      {menu && (
        <div
          className="fixed z-50 w-40 overflow-hidden rounded-box border border-line bg-elev py-1 shadow-xl shadow-black/40"
          style={{
            top: menu.y,
            left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 168),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="truncate px-3 py-1.5 text-[11px] text-dim">{menu.task.task}</p>
          <button
            onClick={() => void deleteTask(menu.task)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-error transition hover:bg-error/10"
          >
            <LuTrash2 className="h-4 w-4" /> Slet opgave
          </button>
        </div>
      )}
    </aside>
  );
}
