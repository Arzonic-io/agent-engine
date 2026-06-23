"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LuBrain, LuListTodo, LuPencil, LuRocket } from "react-icons/lu";
import type {
  MissionSummary,
  Project,
  ProjectTask,
  RepoInfo,
  RoleModelsConfig,
  Rubric,
} from "@arzonic/agent-client";
import {
  ACTIVE_PROJECT_EVENT,
  consumeNewProjectRequest,
  getActiveProject,
  NEW_PROJECT_EVENT,
  useActiveProject,
} from "./lib/activeProject";
import { relTime, repoLabel } from "./lib/format";
import { ProjectFormView } from "./components/ProjectFormView";
import { DefinitionOfDone } from "./components/DefinitionOfDone";
import { MissionComposer } from "./components/MissionComposer";
import { ProjectMissions } from "./components/ProjectMissions";
import { RecentTasks } from "./components/RecentTasks";
import { RepoMenu } from "./components/RepoMenu";
import { TeamRoster } from "./components/TeamRoster";

type Mode = "task" | "mission";

export default function Composer() {
  const router = useRouter();
  const [task, setTask] = useState("");
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useActiveProject();
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [mode, setMode] = useState<Mode>("task");
  const [loaded, setLoaded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [savingRepo, setSavingRepo] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const selected = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  // Initial load: projects (with stats, most-recently-used first), repos, rubric.
  useEffect(() => {
    void (async () => {
      try {
        const [p, r, rb] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/repos"),
          fetch("/api/rubric"),
        ]);
        if (p.ok) {
          const list = ((await p.json()) as Project[]).filter((x) => x.name !== "Scratch");
          setProjects(list);
          const cur = getActiveProject();
          if ((!cur || !list.some((x) => x.id === cur)) && list[0]) setProjectId(list[0].id);
        }
        if (r.ok) setRepos((await r.json()) as RepoInfo[]);
        if (rb.ok) setRubric((await rb.json()) as Rubric);
      } catch {
        /* API still booting — the empty state handles it */
      } finally {
        setLoaded(true);
      }
    })();
  }, [setProjectId]);

  // Recent tasks + missions for the active project.
  useEffect(() => {
    if (!projectId) {
      setTasks([]);
      setMissions([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const [t, m] = await Promise.all([
          fetch(`/api/projects/${projectId}/tasks`),
          fetch("/api/missions"),
        ]);
        if (t.ok && alive) setTasks((await t.json()) as ProjectTask[]);
        if (m.ok && alive) {
          const all = (await m.json()) as MissionSummary[];
          setMissions(all.filter((x) => x.projectId === projectId));
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (loaded) taRef.current?.focus();
  }, [loaded]);

  // Open the "new project" view when the rail's "Nyt projekt" asks for it.
  useEffect(() => {
    if (consumeNewProjectRequest()) setNewOpen(true);
    const onReq = () => setNewOpen(true);
    window.addEventListener(NEW_PROJECT_EVENT, onReq);
    return () => window.removeEventListener(NEW_PROJECT_EVENT, onReq);
  }, []);

  // Picking a project (rail or dropdown) closes the "new project" view.
  useEffect(() => {
    const onSwitch = () => setNewOpen(false);
    window.addEventListener(ACTIVE_PROJECT_EVENT, onSwitch);
    return () => window.removeEventListener(ACTIVE_PROJECT_EVENT, onSwitch);
  }, []);

  async function createProject(data: {
    name: string;
    brief: string;
    repoPath?: string;
    roleModels?: RoleModelsConfig;
  }) {
    if (!data.name.trim()) return;
    setSavingProject(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const project = (await res.json()) as Project;
      setProjects((prev) => [
        { ...project, stats: { memoryCount: 0, taskCount: 0, lastTaskAt: null } },
        ...prev,
      ]);
      setProjectId(project.id);
      setNewOpen(false);
      taRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke oprette projektet");
    } finally {
      setSavingProject(false);
    }
  }

  async function updateProject(data: {
    name: string;
    brief: string;
    repoPath: string;
    roleModels: RoleModelsConfig;
  }) {
    if (!projectId || !data.name.trim()) return;
    setSavingProject(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // repoPath "" clears the bound repo; a path sets it.
        body: JSON.stringify({
          name: data.name,
          brief: data.brief,
          repoPath: data.repoPath || null,
          roleModels: data.roleModels,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = (await res.json()) as Project;
      setProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...updated, stats: p.stats } : p)),
      );
      setEditOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke gemme projektet");
    } finally {
      setSavingProject(false);
    }
  }

  async function saveProjectRepo(path: string | null) {
    if (!projectId) return;
    setSavingRepo(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: path }),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = (await res.json()) as Project;
      setProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...updated, stats: p.stats } : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke gemme repo");
    } finally {
      setSavingRepo(false);
    }
  }

  async function run() {
    if (!task.trim() || starting || !projectId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { runId } = (await res.json()) as { runId: string };
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke starte opgaven");
      setStarting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="loading loading-spinner loading-md text-dim" />
      </div>
    );
  }

  // Create (first-ever or "Nyt projekt") → full-screen form.
  if (projects.length === 0 || newOpen) {
    return (
      <ProjectFormView
        mode="create"
        firstEver={projects.length === 0}
        repos={repos}
        error={error}
        submitting={savingProject}
        onSubmit={(d) =>
          void createProject({
            name: d.name,
            brief: d.brief,
            repoPath: d.repoPath || undefined,
            roleModels: d.roleModels,
          })
        }
        onCancel={() => {
          setNewOpen(false);
          setError(null);
        }}
      />
    );
  }

  // Edit existing project → full-screen form (name + brief + repo).
  if (editOpen && selected) {
    return (
      <ProjectFormView
        mode="edit"
        repos={repos}
        initialName={selected.name}
        initialBrief={selected.brief}
        initialRepo={
          typeof selected.settings?.repoPath === "string" ? (selected.settings.repoPath as string) : ""
        }
        initialTeam={selected.settings?.roleModels as RoleModelsConfig | undefined}
        error={error}
        submitting={savingProject}
        onSubmit={updateProject}
        onCancel={() => {
          setEditOpen(false);
          setError(null);
        }}
      />
    );
  }

  const mem = selected?.stats;
  const projectRepo =
    typeof selected?.settings?.repoPath === "string" ? (selected.settings.repoPath as string) : "";

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto px-6 sm:px-8">
      <div className="w-full max-w-2xl pb-20 pt-[7vh]">
        {/* project header */}
        <div className="rise mb-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-2 text-xs uppercase tracking-[0.35em] text-dim">Arbejder i projekt</p>
              <h1 className="display truncate text-4xl font-extrabold leading-[1.08] tracking-tight">
                {selected?.name}
              </h1>
              {selected?.brief?.trim() && (
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-dim">{selected.brief}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setEditOpen(true);
              }}
              title="Rediger projekt"
              className="btn btn-ghost btn-sm shrink-0 gap-1 text-dim hover:text-fg"
            >
              <LuPencil className="h-3.5 w-3.5" /> Rediger
            </button>
          </div>

          {/* memory + team */}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-dim">
              <LuBrain className="h-3.5 w-3.5" />
              {mem && mem.memoryCount > 0 ? (
                <span>
                  <span className="text-fg/80">{mem.memoryCount} ting husket</span> · sidste opgave{" "}
                  {relTime(mem.lastTaskAt)}
                </span>
              ) : (
                <span>Ingen hukommelse endnu - første opgave</span>
              )}
            </span>
            <span className="text-line">·</span>
            <TeamRoster />
          </div>

          {/* project repo — every task inherits the choice */}
          <div className="mt-3">
            <RepoMenu
              repos={repos}
              value={projectRepo}
              onChange={saveProjectRepo}
              saving={savingRepo}
            />
          </div>
        </div>

        {/* mode toggle — bounded task vs autonomous mission, both inside the project */}
        <div className="rise mb-4 flex items-center justify-between gap-3" style={{ animationDelay: "40ms" }}>
          <div className="inline-flex rounded-field border border-line bg-elev p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setMode("task")}
              className={`flex items-center gap-1.5 rounded-[0.3rem] px-3 py-1.5 transition ${
                mode === "task" ? "bg-panel text-fg shadow" : "text-dim hover:text-fg"
              }`}
            >
              <LuListTodo className="h-4 w-4" /> Opgave
            </button>
            <button
              type="button"
              onClick={() => setMode("mission")}
              className={`flex items-center gap-1.5 rounded-[0.3rem] px-3 py-1.5 transition ${
                mode === "mission" ? "bg-panel text-fg shadow" : "text-dim hover:text-fg"
              }`}
            >
              <LuRocket className="h-4 w-4" /> Mission
            </button>
          </div>
          <span className="hidden text-xs text-dim sm:block">
            {mode === "task"
              ? "Afgrænset · du godkender ved gaten"
              : "Langtkørende · kører autonomt, du overvåger"}
          </span>
        </div>

        {mode === "task" ? (
          <>
            {rubric && <DefinitionOfDone rubric={rubric} />}

            {/* task composer */}
            <div
              className="rise rounded-box border border-line bg-panel p-2 shadow-2xl shadow-black/30"
              style={{ animationDelay: "60ms" }}
            >
              <textarea
                ref={taRef}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void run();
                  }
                }}
                placeholder="Beskriv opgaven… teamet henter projektets hukommelse og vælger selv om det er en hurtig eller en team-opgave."
                rows={5}
                className="w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed text-fg placeholder:text-dim/50 focus:outline-none"
              />

              <div className="flex items-center justify-between gap-3 border-t border-line px-2 pb-1 pt-2">
                <span className="text-xs text-dim">
                  {projectRepo
                    ? `→ grundet i projektets repo (${repoLabel(projectRepo, repos)})`
                    : "→ router vælger single / team"}
                </span>
                <button
                  onClick={() => void run()}
                  disabled={starting || !task.trim()}
                  className="btn btn-primary display gap-2 font-bold normal-case"
                >
                  {starting ? (
                    <>
                      <span className="loading loading-spinner loading-xs" /> Starter…
                    </>
                  ) : (
                    "Kør"
                  )}
                </button>
              </div>
            </div>

            {error && <p className="rise mt-4 text-sm text-error">{error}</p>}
          </>
        ) : (
          <MissionComposer projectId={projectId} repoPath={projectRepo} />
        )}

        <RecentTasks tasks={tasks} />
        <ProjectMissions missions={missions} />

        <p className="rise mt-6 text-xs leading-relaxed text-dim" style={{ animationDelay: "120ms" }}>
          Opgaver hører til et projekt og bygger på dets hukommelse. En router afgør om en hurtig
          builder↔kritiker-runde eller en fuld arkitekt→arbejdere→lead-opdeling passer - du godkender
          bare ved gaten.
        </p>
      </div>
    </div>
  );
}
