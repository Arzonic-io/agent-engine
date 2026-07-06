"use client";

import { useEffect, useRef, useState } from "react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import type { Rubric } from "@arzonic/agent-client";

/**
 * Per-project rubric editor (edit mode only). Loads the project's effective
 * rubric, lets the operator tune the pass threshold, edit/add/remove criteria,
 * and save. The three universal required criteria (correct / complete /
 * matches-task) are the floor — shown locked; the server re-enforces them on save
 * regardless, so this is a convenience, not the guarantee.
 */
const BASE_IDS = ["correctness", "completeness", "matches-task"];
const isBase = (id: string) => BASE_IDS.includes(id);

export function ProjectRubricEditor({ projectId }: { projectId: string }) {
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const counter = useRef(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/rubric`);
        if (res.ok && alive) setRubric((await res.json()) as Rubric);
      } catch {
        /* best-effort — the section just stays hidden */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (!rubric) return null;

  const patch = (next: Partial<Rubric>) => {
    setRubric((r) => (r ? { ...r, ...next } : r));
    setStatus("idle");
  };
  const editCriterion = (id: string, description: string) =>
    patch({ criteria: rubric.criteria.map((c) => (c.id === id ? { ...c, description } : c)) });
  const toggleRequired = (id: string) =>
    patch({ criteria: rubric.criteria.map((c) => (c.id === id ? { ...c, required: !c.required } : c)) });
  const remove = (id: string) =>
    patch({ criteria: rubric.criteria.filter((c) => c.id !== id) });
  const add = () =>
    patch({
      criteria: [
        ...rubric.criteria,
        { id: `custom-${(counter.current += 1)}-${rubric.criteria.length}`, description: "", required: false },
      ],
    });

  const save = async () => {
    setSaving(true);
    setStatus("idle");
    // Drop empty custom rows; the base criteria always carry text.
    const criteria = rubric.criteria.filter((c) => isBase(c.id) || c.description.trim());
    try {
      const res = await fetch(`/api/projects/${projectId}/rubric`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria, passThreshold: rubric.passThreshold }),
      });
      if (res.ok) {
        setRubric((await res.json()) as Rubric);
        setStatus("saved");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 rounded-box border border-line bg-panel/40 p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg/90">Kvalitetskrav</h3>
        <span className="text-xs text-dim">Definition of Done for dette projekt</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Kritikeren scorer hvert udkast mod disse krav. De tre påkrævede (korrekt · komplet · rammer
        opgaven) er universelle og kan ikke fjernes.
      </p>

      <label className="mb-4 flex items-center gap-3 text-xs text-fg/80">
        <span className="shrink-0">Beståelsestærskel</span>
        <input
          type="number"
          min={0}
          max={100}
          value={rubric.passThreshold}
          onChange={(e) =>
            patch({ passThreshold: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
          }
          className="w-20 rounded-field bg-elev/60 px-2 py-1 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-line"
        />
        <span className="text-dim">/ 100</span>
      </label>

      <ul className="space-y-2">
        {rubric.criteria.map((c) => {
          const base = isBase(c.id);
          return (
            <li key={c.id} className="flex items-start gap-2">
              {base ? (
                // Base criteria are locked — show the Danish label as static text.
                <span className="flex-1 rounded-field bg-elev/30 px-2.5 py-1.5 text-xs leading-relaxed text-fg/70">
                  {c.label ?? c.description}
                </span>
              ) : (
                <input
                  value={c.description}
                  onChange={(e) => editCriterion(c.id, e.target.value)}
                  placeholder="Beskriv kravet som en testbar påstand…"
                  className="flex-1 rounded-field bg-elev/60 px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-line"
                />
              )}
              <button
                type="button"
                onClick={() => !base && toggleRequired(c.id)}
                disabled={base}
                title={base ? "Universelt påkrævet" : c.required ? "Påkrævet" : "Valgfrit"}
                className={`shrink-0 rounded-field px-2 py-1.5 text-[10px] uppercase tracking-wide transition ${
                  c.required ? "bg-critic/15 text-critic" : "bg-elev text-dim hover:text-fg"
                } ${base ? "cursor-default opacity-80" : ""}`}
              >
                {c.required ? "påkrævet" : "valgfrit"}
              </button>
              <button
                type="button"
                onClick={() => remove(c.id)}
                disabled={base}
                title={base ? "Kan ikke fjernes" : "Fjern krav"}
                className="shrink-0 rounded-field p-1.5 text-dim transition hover:text-critic disabled:cursor-default disabled:opacity-30"
              >
                <LuTrash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={add}
          className="btn btn-ghost btn-sm gap-1.5 text-dim hover:text-fg"
        >
          <LuPlus className="h-3.5 w-3.5" /> Tilføj krav
        </button>
        <div className="flex items-center gap-3">
          {status === "saved" && <span className="text-xs text-builder">Gemt</span>}
          {status === "error" && <span className="text-xs text-critic">Kunne ikke gemme</span>}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="btn btn-soft btn-sm disabled:opacity-50"
          >
            {saving ? "Gemmer…" : "Gem kvalitetskrav"}
          </button>
        </div>
      </div>
    </div>
  );
}
