"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LuInfo, LuKeyRound, LuSave, LuSettings, LuSlidersHorizontal, LuUsers, LuX } from "react-icons/lu";
import type { AppSettings, ModelProvider } from "@arzonic/agent-client";
import {
  TEAM_ROLES,
  TeamModelPicker,
  roleModelsToSelection,
  selectionToRoleModels,
  type TeamSelection,
} from "./TeamModelPicker";

type SectionKey = "team" | "providers" | "general" | "about";

const SECTIONS: { key: SectionKey; label: string; icon: typeof LuUsers }[] = [
  { key: "team", label: "Team-modeller", icon: LuUsers },
  { key: "providers", label: "Providers & nøgler", icon: LuKeyRound },
  { key: "general", label: "Generelt", icon: LuSlidersHorizontal },
  { key: "about", label: "Om", icon: LuInfo },
];

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  mistral: "Mistral",
  anthropic: "Claude (Anthropic)",
  google: "Gemini (Google)",
};

/**
 * App settings — a 75%-of-screen modal with a section menubar. The implemented
 * section is "Team-modeller": editing the GLOBAL DEFAULT team config (which
 * provider/model each role uses), persisted server-side so it changes at runtime.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  // Portal to <body> so the overlay escapes the LeftRail's stacking/clipping
  // context (a transformed/overflow ancestor would otherwise trap `fixed`).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [section, setSection] = useState<SectionKey>("team");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sel, setSel] = useState<TeamSelection>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error(await res.text());
        const s = (await res.json()) as AppSettings;
        if (!alive) return;
        setSettings(s);
        setSel(roleModelsToSelection(s.roleModels));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Kunne ikke hente indstillinger");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/role-models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleModels: selectionToRoleModels(sel) }),
      });
      if (!res.ok) throw new Error(await res.text());
      const s = (await res.json()) as AppSettings;
      setSettings(s);
      setSel(roleModelsToSelection(s.roleModels));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunne ikke gemme");
    } finally {
      setSaving(false);
    }
  }

  const envBaseline = settings
    ? Object.entries(settings.envRoleModels).map(([r, s]) => `${r}=${s.provider}`)
    : [];

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex h-[75vh] w-[75vw] max-w-[1100px] overflow-hidden rounded-box border border-line bg-panel shadow-2xl shadow-black/40">
        {/* ── menubar ── */}
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-elev/30 p-3">
          <div className="flex items-center gap-2 px-2 pb-3 pt-1 text-[11px] uppercase tracking-[0.28em] text-dim">
            <LuSettings className="h-3.5 w-3.5" /> Indstillinger
          </div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`flex items-center gap-2.5 rounded-field px-3 py-2 text-left text-sm transition ${
                  section === s.key ? "bg-elev text-fg" : "text-dim hover:bg-elev/60 hover:text-fg"
                }`}
              >
                <Icon className="h-4 w-4" /> {s.label}
              </button>
            );
          })}
        </nav>

        {/* ── content ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-base font-bold">{SECTIONS.find((s) => s.key === section)?.label}</h2>
            <button onClick={onClose} className="btn btn-ghost btn-sm btn-square" aria-label="Luk">
              <LuX className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {loading ? (
              <p className="text-sm text-dim">Henter…</p>
            ) : section === "team" ? (
              <div className="max-w-2xl">
                <p className="mb-4 text-sm leading-relaxed text-dim">
                  Hvert team-medlem er en <span className="text-fg">stilling</span>, der kan køre på sin egen
                  model. Vælg en provider — og evt. en bestemt model — pr. stilling; <span className="text-fg">Standard</span>{" "}
                  bruger den globale provider. Gemmes med det samme og bruges på næste kørsel. En enkelt mission
                  kan stadig vælge sit eget team i sin opsætning.
                </p>
                <TeamModelPicker
                  roles={TEAM_ROLES}
                  value={sel}
                  onChange={setSel}
                  availableProviders={settings?.availableProviders}
                />
                {envBaseline.length > 0 && (
                  <p className="mt-3 text-[11px] text-dim/70">Env-baseline: {envBaseline.join(", ")}</p>
                )}
                <div className="mt-5 flex items-center gap-3">
                  <button
                    onClick={() => void save()}
                    disabled={saving || !settings?.persisted}
                    className="btn btn-primary btn-sm gap-2 normal-case"
                  >
                    {saving ? (
                      <>
                        <span className="loading loading-spinner loading-xs" /> Gemmer…
                      </>
                    ) : (
                      <>
                        <LuSave className="h-4 w-4" /> Gem standard
                      </>
                    )}
                  </button>
                  {saved && <span className="text-xs text-builder">Gemt ✓</span>}
                  {settings && !settings.persisted && (
                    <span className="text-xs text-warning">
                      Kræver en database (SUPABASE_DB_URL) for at gemme.
                    </span>
                  )}
                </div>
              </div>
            ) : section === "providers" ? (
              <div className="max-w-2xl">
                <p className="mb-4 text-sm leading-relaxed text-dim">
                  Providers er aktiveret server-side via API-nøgler i miljøet. Kun aktiverede providers kan
                  vælges i Team-modeller.
                </p>
                <ul className="space-y-1.5">
                  {(["mistral", "anthropic", "google"] as ModelProvider[]).map((p) => {
                    const on = settings?.availableProviders.includes(p);
                    return (
                      <li
                        key={p}
                        className="flex items-center justify-between rounded-field border border-line bg-elev/40 px-3 py-2 text-sm"
                      >
                        <span className="text-fg">{PROVIDER_LABEL[p]}</span>
                        <span className={`text-xs ${on ? "text-builder" : "text-dim"}`}>
                          {on ? "Aktiveret ✓" : "Mangler nøgle"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : section === "general" ? (
              <p className="text-sm text-dim">Flere indstillinger kommer her.</p>
            ) : (
              <div className="max-w-2xl text-sm leading-relaxed text-dim">
                <p className="text-fg">Multi Agent Team</p>
                <p className="mt-1">Arzonics interne multi-agent-motor. Indstillinger gemmes server-side.</p>
              </div>
            )}

            {error && <p className="mt-4 text-sm text-error">{error}</p>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
