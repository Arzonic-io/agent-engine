"use client";

import { useState } from "react";
import { LuChevronRight, LuTarget } from "react-icons/lu";
import type { Rubric } from "@arzonic/agent-client";

/** Collapsible "Definition of Done" — the rubric the critic scores against. */
export function DefinitionOfDone({ rubric }: { rubric: Rubric }) {
  const [open, setOpen] = useState(false);
  if (rubric.criteria.length === 0) return null;

  return (
    <div
      className="rise mb-4 overflow-hidden rounded-box border border-line bg-panel/60"
      style={{ animationDelay: "45ms" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <LuTarget className="h-4 w-4 text-critic" />
        <span className="text-sm text-fg/90">
          Kvalitetskrav <span className="text-dim">· Definition of Done</span>
        </span>
        <span className="ml-auto text-xs text-dim">{rubric.criteria.length} krav</span>
        <LuChevronRight
          className={`h-4 w-4 text-dim transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-line px-3 py-2.5">
          {rubric.criteria.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-xs leading-relaxed">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-dim" />
              <span className="text-fg/80">
                {c.label ?? c.description}
                {c.required && (
                  <span className="ml-1.5 rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim">
                    påkrævet
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
