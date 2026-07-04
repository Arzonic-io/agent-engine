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
  /** What the critic should check, phrased as a falsifiable statement. */
  description: string;
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
      required: true,
    },
    {
      id: "completeness",
      description:
        "The draft fully addresses every part of the task; nothing requested is missing or hand-waved.",
      required: true,
    },
    {
      id: "matches-task",
      description:
        "The draft answers the task that was actually asked, without drifting into unrequested scope.",
      required: true,
    },
    {
      id: "edge-cases",
      description:
        "Obvious edge cases, failure modes, and security pitfalls are handled or explicitly called out.",
      required: false,
    },
    {
      id: "clarity",
      description:
        "The draft is well-structured and unambiguous; a competent reader can act on it without guessing.",
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

  // Base required first — locked to `required`, canonical text as fallback.
  for (const base of BASE_REQUIRED_CRITERIA) {
    const edited = override.criteria.find((c) => c.id === base.id);
    criteria.push({
      id: base.id,
      description: edited?.description.trim() || base.description,
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
