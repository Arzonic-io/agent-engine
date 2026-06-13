/**
 * Rubric / Definition of Done.
 *
 * This is the primary quality lever of the engine: the critic scores every
 * draft against these criteria. Pass = every `required` criterion met AND
 * score >= passThreshold. Edit this config (or pass your own rubric to
 * `createAgentGraph`) instead of tweaking prompt strings.
 */

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
