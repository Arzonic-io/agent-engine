import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
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
  detail: z.string().optional().describe("One or two sentences of specifics."),
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
      detail: raw.detail?.trim() || undefined,
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
  const { mission, existingTitles } = input;
  return [
    `# Mission goal\n${mission.goal}`,
    mission.acceptanceCriteria.length
      ? `# Acceptance criteria\n${mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    existingTitles && existingTitles.length
      ? `# Already in the backlog (do not duplicate)\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface MakeDecomposerOptions extends DecomposeGuardOptions {}

export function makeDecomposer(
  model: BaseChatModel,
  options: MakeDecomposerOptions = {},
): Decomposer {
  const structured = model.withStructuredOutput(DecomposeOutputSchema, {
    name: "decompose",
    includeRaw: true,
  });

  return {
    async decompose(input: DecomposeInput): Promise<DecomposeResult> {
      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(buildPrompt(input)),
      ]);
      const output = DecomposeOutputSchema.parse(parsed);
      const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;
      return applyDecomposeGuards(output, tokens, options);
    },
  };
}
