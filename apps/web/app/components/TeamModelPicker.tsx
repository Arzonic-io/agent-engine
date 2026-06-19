"use client";

import type { ModelProvider, ModelSpec, RoleModelsConfig } from "@arzonic/agent-client";

/** A role ("stilling") that can be pinned to its own model — human label, hint, dot colour. */
export interface TeamRole {
  key: string;
  label: string;
  hint: string;
  /** Tailwind bg-* class for the role's colour dot (matches the create-view roster). */
  dot: string;
}

/** Per-role UI selection: provider "" means "Standard" (inherit the default). */
export type TeamSelection = Record<string, { provider: string; model: string }>;

/**
 * The team "stillinger" — human job titles + the same colours the create-view
 * roster uses (Udvikler=builder, Kritiker=critic, Arkitekt=lead, Lead=human),
 * with distinct colours for the mission-only planning roles.
 */
export const TEAM_ROLES: TeamRole[] = [
  { key: "decompose", label: "Planlægger", hint: "mål → backlog", dot: "bg-analyst" },
  { key: "architect", label: "Arkitekt", hint: "designer trinene", dot: "bg-lead" },
  { key: "implementer", label: "Udvikler", hint: "skriver koden", dot: "bg-builder" },
  { key: "critic", label: "Kritiker", hint: "udfordrer arbejdet", dot: "bg-critic" },
  { key: "lead", label: "Lead", hint: "samler resultatet", dot: "bg-human" },
  { key: "replan", label: "Koordinator", hint: "beslutter næste skridt", dot: "bg-warning" },
];

const PROVIDERS: { value: string; label: string }[] = [
  { value: "", label: "Standard" },
  { value: "mistral", label: "Mistral" },
  { value: "anthropic", label: "Claude" },
  { value: "google", label: "Gemini" },
];

/** Collapse a selection into the wire shape, dropping "Standard" (inherit). */
export function selectionToRoleModels(sel: TeamSelection): RoleModelsConfig {
  const out: RoleModelsConfig = {};
  for (const [role, s] of Object.entries(sel)) {
    if (!s.provider) continue;
    const provider = s.provider as ModelProvider;
    out[role] = s.model.trim() ? { provider, model: s.model.trim() } : { provider };
  }
  return out;
}

/** Build a UI selection from a stored config (for editing existing settings). */
export function roleModelsToSelection(cfg: RoleModelsConfig | undefined): TeamSelection {
  const out: TeamSelection = {};
  for (const [role, s] of Object.entries(cfg ?? {})) {
    out[role] = { provider: (s as ModelSpec).provider, model: (s as ModelSpec).model ?? "" };
  }
  return out;
}

/** How many roles are pinned (not "Standard"). */
export function teamCount(sel: TeamSelection): number {
  return Object.values(sel).filter((s) => s.provider).length;
}

/**
 * A compact per-role provider/model picker, reused by the mission composer (a
 * mission's own team) and settings (the global default team). `availableProviders`,
 * when given, disables providers whose API key isn't configured server-side.
 */
export function TeamModelPicker({
  roles,
  value,
  onChange,
  availableProviders,
}: {
  roles: TeamRole[];
  value: TeamSelection;
  onChange: (next: TeamSelection) => void;
  availableProviders?: ModelProvider[];
}) {
  return (
    <div className="space-y-2">
      {roles.map((role) => {
        const sel = value[role.key] ?? { provider: "", model: "" };
        const custom = !!sel.provider;
        return (
          <div
            key={role.key}
            className={`flex items-center gap-3 rounded-field border px-2.5 py-1.5 transition ${
              custom ? "border-line bg-elev/50" : "border-transparent hover:bg-elev/30"
            }`}
          >
            <span className="flex w-36 shrink-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${role.dot}`} />
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-xs font-semibold text-fg">{role.label}</span>
                <span className="block truncate text-[10px] text-dim">{role.hint}</span>
              </span>
            </span>
            <select
              value={sel.provider}
              onChange={(e) => onChange({ ...value, [role.key]: { ...sel, provider: e.target.value } })}
              className="select select-xs w-28 border-line bg-elev text-xs"
            >
              {PROVIDERS.map((p) => {
                const disabled =
                  !!availableProviders &&
                  p.value !== "" &&
                  !availableProviders.includes(p.value as ModelProvider);
                return (
                  <option key={p.value} value={p.value} disabled={disabled}>
                    {p.label}
                    {disabled ? " (ingen nøgle)" : ""}
                  </option>
                );
              })}
            </select>
            <input
              value={sel.model}
              onChange={(e) => onChange({ ...value, [role.key]: { ...sel, model: e.target.value } })}
              disabled={!custom}
              placeholder={custom ? "model (valgfri)" : "—"}
              className="input input-xs flex-1 border-line bg-elev text-xs disabled:opacity-40"
            />
          </div>
        );
      })}
    </div>
  );
}
