import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { RepoTools } from "../tools.js";
import { surveyRepo } from "./repoSurvey.js";
import type {
  DecomposedItem,
  DecomposeInput,
  DecomposeResult,
  Decomposer,
} from "../controller.js";

/**
 * M3 Trin 1 — the Lead's decomposer. At mission start, when the backlog is empty,
 * it turns the goal + acceptance criteria into a concrete, ordered backlog of
 * small, independently-verifiable items. This is the step that makes a mission
 * grow its OWN plan from a goal instead of being hand-seeded — the foundation for
 * autonomous overnight runs (the north star). The `Decomposer` the controller
 * injects; the controller resolves the key-based dependencies to real ids and
 * only ever calls this on an empty backlog (resume never re-decomposes).
 *
 * Like the replanner, the model's freedom is bounded in code (`applyDecomposeGuards`):
 * the item count is capped, keys are made unique, empty titles are dropped, and
 * dependencies pointing at unknown keys are removed — so a model slip can never
 * wedge the loop with a malformed plan.
 */

const SYSTEM_PROMPT = `You are the Lead planner of an autonomous engineering mission. Given a goal and
its acceptance criteria, decompose it into the INITIAL backlog: a set of small,
concrete, independently-verifiable work items that, done in order, reach the goal.

Rules for a good backlog:
- Each item is one self-contained, imperative deliverable ("Add X", "Implement Y"),
  small enough to be built and verified on its own — not a vague phase or "improve".
- Order with dependencies: give every item a short unique "key" (a slug like
  "schema" or "auth-api"), and list the keys it dependsOn (items that must be done
  first). Keep the dependency graph minimal — only real ordering constraints.
- Set priority so foundational/blocking work sorts first (higher = sooner).
- Mark risk:"high" for deploy / data-deletion / payments / secrets / choosing an
  external provider / other irreversible actions — those get parked for a human.
- Prefer 3–12 items. Do not pad with busywork; do not bundle unrelated work.
- Do NOT add a separate "write tests" item per feature — verification runs real
  checks already; only add a test item when the goal explicitly asks for a suite.

LANGUAGE: Write item text and reasoning in the same language as the goal — Danish
if the goal is in Danish, otherwise English. Use only Danish or English.`;

const DecomposeItemSchema = z.object({
  key: z
    .string()
    .describe("Short unique slug naming this item, e.g. 'schema' — used to declare dependencies."),
  title: z.string().describe("Concrete, imperative, self-contained item title."),
  detail: z
    .string()
    .optional()
    .describe("The specifics: what to actually do, and the approach — not a reworded title."),
  // files/verify are folded INTO `detail` by the guards below rather than stored
  // as columns: the implementer reads the item as one task string, so a separate
  // shape would mean a backlog migration for text that ends up concatenated anyway.
  files: z
    .array(z.string())
    .default([])
    .describe("Exact paths this item creates or changes, taken from the survey — never guessed."),
  verify: z
    .string()
    .optional()
    .describe("The concrete check that proves this item works — prefer one the survey confirmed exists."),
  priority: z
    .number()
    .int()
    .optional()
    .describe("Higher = worked sooner. Foundational/blocking items get higher values."),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe("Keys of items in this backlog that must be done before this one."),
  risk: z
    .enum(["low", "high"])
    .optional()
    .describe("high for deploy/delete/payment/secrets/provider-choice/irreversible actions."),
});

const DecomposeOutputSchema = z.object({
  items: z
    .array(DecomposeItemSchema)
    .describe("The initial backlog, ordered toward the goal."),
  reasoning: z
    .string()
    .optional()
    .describe("One sentence: the shape of the plan, for the journal."),
});
export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

export interface DecomposeGuardOptions {
  /** Hard cap on items, so a runaway plan can't flood the backlog. Default 40. */
  maxItems?: number;
}

/**
 * Flatten an item's specifics into the single `detail` string the backlog stores
 * and the runner concatenates into the implementer's task. Empty sections are
 * dropped, so a blind (no-survey) decomposition still yields exactly the old
 * shape — plain prose, no empty headings.
 */
function composeDetail(raw: {
  detail?: string;
  files?: string[];
  verify?: string;
}): string | undefined {
  const files = (raw.files ?? []).map((f) => f.trim()).filter(Boolean);
  const parts = [
    raw.detail?.trim(),
    files.length ? `Files: ${files.join(", ")}` : "",
    raw.verify?.trim() ? `Verify: ${raw.verify.trim()}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Make the model's plan safe deterministically: cap the count, drop empty titles,
 * force unique keys, and strip dependsOn entries that point at unknown keys (or at
 * the item itself). The controller's `createDecomposedItems` then resolves the
 * surviving keys to real ids.
 */
export function applyDecomposeGuards(
  output: DecomposeOutput,
  tokensUsed: number,
  options: DecomposeGuardOptions = {},
): DecomposeResult {
  const maxItems = options.maxItems ?? 40;
  const seen = new Set<string>();
  const items: DecomposedItem[] = [];

  for (let i = 0; i < output.items.length && items.length < maxItems; i++) {
    const raw = output.items[i]!;
    const title = raw.title?.trim();
    if (!title) continue; // a titleless item is not actionable — drop it

    let key = raw.key?.trim() || `item-${i + 1}`;
    while (seen.has(key)) key = `${key}-${i}`; // force uniqueness
    seen.add(key);

    items.push({
      key,
      title,
      detail: composeDetail(raw),
      priority: raw.priority,
      dependsOn: raw.dependsOn ?? [],
      risk: raw.risk,
    });
  }

  // Drop dependencies pointing at keys that didn't survive (or at self).
  const keys = new Set(items.map((it) => it.key!));
  for (const it of items) {
    it.dependsOn = (it.dependsOn ?? []).filter((k) => keys.has(k) && k !== it.key);
  }

  return { items, note: output.reasoning, tokensUsed };
}

function buildPrompt(input: DecomposeInput): string {
  const { mission, existingTitles, continuation, rubricGaps } = input;
  return [
    `# Mission goal\n${mission.goal}`,
    mission.acceptanceCriteria.length
      ? `# Acceptance criteria\n${mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    // Strategic re-plan (blocker 3): the initial backlog has been worked but the
    // goal may not be fully met. Ask for the NEXT slice toward the goal, or an
    // explicit empty list when the acceptance criteria are genuinely satisfied —
    // that empty result is how the mission converges to "done" instead of churning.
    continuation
      ? `# Continuation — the backlog so far has been worked\nReview the goal and acceptance criteria against what has already been attempted (listed below). Propose ONLY new, concrete, goal-relevant items that are still needed to reach the goal — gaps, missing pieces, follow-through. If the goal and every acceptance criterion are already satisfied, return an EMPTY items list (do not invent busywork).`
      : "",
    // Rubric-aware continuation: the project was scored against its Definition of
    // Done and these criteria are still unmet. Aim the next slice squarely at
    // closing them — this is what makes the mission converge on "good enough",
    // not just "list drained". Empty list only if none of these can be advanced.
    rubricGaps && rubricGaps.length
      ? `# Definition of Done — criteria NOT yet met\nThe project was assessed against its Definition of Done and these criteria are still unmet. Plan concrete work items that specifically CLOSE these gaps (prioritise them):\n${rubricGaps
          .map((g) => `- [${g.id}] ${g.description}${g.note ? ` — still missing: ${g.note}` : ""}`)
          .join("\n")}`
      : "",
    // Operator guidance (M3 Trin 6): a human's steer, if set before planning — it
    // shapes the initial backlog the same way it later shapes replans.
    mission.guidance?.trim()
      ? `# Operator guidance (follow this — a human is steering the mission)\n${mission.guidance.trim()}`
      : "",
    existingTitles && existingTitles.length
      ? `# Already in the backlog (do not duplicate)\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Appended when a survey succeeded. A mission's backlog is the highest-leverage
 * handoff in the system: every item is executed later, in a fresh worktree, by an
 * implementer that starts with no memory of this planning step. Whatever the
 * planner knows and does not write down here is re-derived per item — paid for
 * once at planning and again at every execution.
 */
const GROUNDED_PROMPT = `

A survey of the actual codebase is provided below. Plan against it, not against
assumptions. Each item is handed to an implementer that starts fresh in a clean
worktree with no memory of this planning — so put what it needs INTO the item:

- "files": the exact paths, taken from the survey. Never invent a path.
- "detail": what to actually do there, and the approach.
- "verify": the check that proves it — prefer one the survey confirmed exists.

Leave a field out rather than guessing. A missing field costs the implementer one
look; a wrong one sends it to the wrong file.`;

export interface MakeDecomposerOptions extends DecomposeGuardOptions {
  /**
   * Read-only repo access. When present the planner SURVEYS the code before
   * decomposing, so items name real files and real checks instead of describing
   * work in the abstract. Omit to keep the original blind behaviour.
   */
  repo?: RepoTools;
  /** Per-call LLM timeout for the survey loop. */
  llmCallTimeoutMs?: number;
}

export function makeDecomposer(
  model: BaseChatModel,
  options: MakeDecomposerOptions = {},
): Decomposer {
  const structured = model.withStructuredOutput(DecomposeOutputSchema, {
    name: "decompose",
    includeRaw: true,
  });
  const { repo, llmCallTimeoutMs } = options;

  return {
    async decompose(input: DecomposeInput): Promise<DecomposeResult> {
      // Best-effort by contract — a failed survey degrades to blind planning
      // rather than blocking a mission from starting at all.
      const surveyed = repo
        ? await surveyRepo({
            model,
            repo,
            brief: [
              input.mission.goal,
              input.mission.acceptanceCriteria.length
                ? `Acceptance criteria:\n${input.mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            llmCallTimeoutMs,
          })
        : { survey: "", tokensUsed: 0 };

      const prompt = surveyed.survey
        ? `${buildPrompt(input)}\n\n# Survey of the codebase (verified — plan against this)\n${surveyed.survey}`
        : buildPrompt(input);

      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT + (surveyed.survey ? GROUNDED_PROMPT : "")),
        new HumanMessage(prompt),
      ]);
      const output = DecomposeOutputSchema.parse(parsed);
      const tokens =
        surveyed.tokensUsed + ((raw as AIMessage).usage_metadata?.total_tokens ?? 0);
      return applyDecomposeGuards(output, tokens, options);
    },
  };
}
