"use client";

import type { ModelProvider, ModelSpec, RoleModelsConfig } from "@arzonic/agent-client";

/** A role that can be pinned to its own model, with a human label. */
export interface TeamRole {
  key: string;
  label: string;
  hint: string;
}

/** Per-role UI selection: provider "" means "Standard" (inherit the default). */
export type TeamSelection = Record<string, { provider: string; model: string }>;

/** The roles that actually run in a mission — the configurable team members. */
export const TEAM_ROLES: TeamRole[] = [
  { key: "decompose", label: "Decompose", hint: "mål → backlog" },
  { key: "architect", label: "Arkitekt", hint: "planlægger" },
  { key: "implementer", label: "Implementer", hint: "skriver koden" },
  { key: "critic", label: "Kritiker", hint: "udfordrer" },
  { key: "lead", label: "Lead", hint: "samler" },
  { key: "replan", label: "Replan", hint: "done + follow-ups" },
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
    <div className="space-y-1.5">
      {roles.map((role) => {
        const sel = value[role.key] ?? { provider: "", model: "" };
        return (
          <div key={role.key} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg">
              {role.label}
              <span className="ml-1 text-dim/50">· {role.hint}</span>
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
              disabled={!sel.provider}
              placeholder={sel.provider ? "model (valgfri)" : "—"}
              className="input input-xs flex-1 border-line bg-elev text-xs disabled:opacity-40"
            />
          </div>
        );
      })}
    </div>
  );
}
