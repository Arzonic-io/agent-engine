/**
 * Rubric / Definition of Done.
 *
 * This is the primary quality lever of the engine: the critic scores every
 * draft against these criteria. Pass = every `required` criterion met AND
 * score >= passThreshold. Edit this config (or pass your own rubric to
 * `createAgentGraph`) instead of tweaking prompt strings.
 */

import { z } from "zod";

export interface RubricCriterion {
  /** Stable id the critic references in its structured verdict. */
  id: string;
  /** What the critic should check, phrased as a falsifiable statement. Fed to the
   *  model — kept in English so the rubric the critic scores against is stable. */
  description: string;
  /** Optional human-facing (Danish) label shown in the UI instead of the English
   *  `description`. The model never sees this; it's display-only. */
  label?: string;
  /** Required criteria must ALL be met for a pass, regardless of score. */
  required: boolean;
}

export interface Rubric {
  criteria: RubricCriterion[];
  /** 0-100. The critic's overall score must reach this for a pass. */
  passThreshold: number;
}

export const defaultRubric: Rubric = {
  passThreshold: 80,
  criteria: [
    {
      id: "correctness",
      description:
        "The draft is factually and technically correct; no broken logic, wrong APIs, or false claims.",
      label: "Korrekt — fagligt og teknisk rigtigt; ingen brudt logik, forkerte API'er eller falske påstande.",
      required: true,
    },
    {
      id: "completeness",
      description:
        "The draft fully addresses every part of the task; nothing requested is missing or hand-waved.",
      label: "Komplet — dækker hele opgaven; intet efterspurgt mangler eller er viftet væk.",
      required: true,
    },
    {
      id: "matches-task",
      description:
        "The draft answers the task that was actually asked, without drifting into unrequested scope.",
      label: "Rammer opgaven — svarer på det der faktisk blev bedt om, uden at drive ud i uønsket scope.",
      required: true,
    },
    {
      id: "edge-cases",
      description:
        "Obvious edge cases, failure modes, and security pitfalls are handled or explicitly called out.",
      label: "Kanttilfælde — oplagte fejltilstande og sikkerhedsfælder er håndteret eller nævnt eksplicit.",
      required: false,
    },
    {
      id: "clarity",
      description:
        "The draft is well-structured and unambiguous; a competent reader can act on it without guessing.",
      label: "Klarhed — velstruktureret og utvetydig; en kompetent læser kan handle uden at gætte.",
      required: false,
    },
  ],
};

export function renderRubric(rubric: Rubric): string {
  return rubric.criteria
    .map(
      (c) =>
        `- [${c.id}]${c.required ? " (REQUIRED)" : ""} ${c.description}`,
    )
    .join("\n");
}

// ── Per-project rubrics ──────────────────────────────────────────────────────

export const RubricCriterionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "id must be kebab-case (a-z, 0-9, -)"),
  description: z.string().trim().min(1).max(2000),
  label: z.string().trim().max(2000).optional(),
  required: z.boolean(),
});

export const RubricSchema = z.object({
  criteria: z.array(RubricCriterionSchema).min(1).max(30),
  passThreshold: z.number().int().min(0).max(100),
});

/**
 * The universal required criteria a per-project rubric can never drop — the
 * "floor" (correct / complete / matches-task). Derived from the default rubric so
 * the two never drift.
 */
export const BASE_REQUIRED_CRITERIA: RubricCriterion[] = defaultRubric.criteria.filter(
  (c) => c.required,
);

/**
 * Turn a human-edited per-project rubric into the effective one the critic runs
 * with. The floor is enforced server-side: every universal required criterion is
 * present and stays `required` (re-added with its canonical text if edited away or
 * removed), regardless of what the client sent. Optional + custom criteria and the
 * pass threshold pass through as the operator set them. Pure and idempotent.
 */
export function resolveProjectRubric(override: Rubric): Rubric {
  const seen = new Set<string>();
  const criteria: RubricCriterion[] = [];

  // Base required first — locked to `required`, canonical text as fallback, and the
  // canonical Danish label carried through (display-only; the model reads description).
  for (const base of BASE_REQUIRED_CRITERIA) {
    const edited = override.criteria.find((c) => c.id === base.id);
    criteria.push({
      id: base.id,
      description: edited?.description.trim() || base.description,
      ...(base.label ? { label: base.label } : {}),
      required: true,
    });
    seen.add(base.id);
  }

  // Then the operator's optional + custom criteria, in the order they gave them,
  // skipping the base ids (already placed) and any duplicate ids.
  for (const c of override.criteria) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    criteria.push({ ...c, description: c.description.trim() });
  }

  return {
    passThreshold: Math.max(0, Math.min(100, Math.round(override.passThreshold))),
    criteria,
  };
}

/**
 * Fold adaptive, task-relevant criteria onto a base rubric for a single run. Extra
 * criteria are added as OPTIONAL only (forced `required: false`) — a model-proposed
 * criterion informs the score and feedback but can never gate a pass or displace a
 * base criterion. Ids already in the base are dropped (base wins). Pure; returns the
 * base unchanged when there's nothing to add.
 */
export function augmentRubric(base: Rubric, extra: RubricCriterion[]): Rubric {
  if (!extra?.length) return base;
  const seen = new Set(base.criteria.map((c) => c.id));
  const additions: RubricCriterion[] = [];
  for (const c of extra) {
    if (!c.id || !c.description.trim() || seen.has(c.id)) continue;
    seen.add(c.id);
    additions.push({ id: c.id, description: c.description.trim(), required: false });
  }
  if (additions.length === 0) return base;
  return { passThreshold: base.passThreshold, criteria: [...base.criteria, ...additions] };
}
