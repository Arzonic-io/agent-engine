/**
 * Throwaway proof of the adaptive Definition of Done (backlog item b): a proposer
 * suggests task-relevant EXTRA criteria that the critic folds in as OPTIONAL — they
 * inform score + feedback but can never gate a pass or displace a base criterion.
 * Hermetic: scripted fake models, no LLM. Covers augmentRubric, the proposer node's
 * guards (slug/dedupe/base-drop/cap/no-op-when-off), and the critic reading them.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-adaptive.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { augmentRubric, defaultRubric } from "./src/rubric.js";
import { makeProposeCriteriaNode } from "./src/nodes/proposeCriteria.js";
import { makeCriticNode } from "./src/nodes/critic.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };

/** A fake structured model: every withStructuredOutput().invoke() returns `parsed`. */
function scriptedModel(parsed: unknown): BaseChatModel {
  return {
    withStructuredOutput() {
      return {
        async invoke() {
          return { raw: new AIMessage({ content: "", usage_metadata: usage }), parsed };
        },
      };
    },
  } as unknown as BaseChatModel;
}

function state(over: Partial<GraphStateType> = {}): GraphStateType {
  return {
    task: "Refactor the auth handler",
    messages: [],
    draft: "the draft",
    round: 1,
    verdict: null,
    status: "running",
    tokensUsed: 10,
    humanNotes: "",
    plan: [],
    currentStep: 0,
    stepResults: [],
    projectId: "",
    context: "",
    topology: "single",
    forcedTopology: null,
    extraCriteria: [],
    ...over,
  } as GraphStateType;
}

// ── 1. augmentRubric: extras are optional-only, base wins, base unchanged when empty ──
{
  ok(augmentRubric(defaultRubric, []) === defaultRubric, "no extras ⇒ the base rubric is returned untouched");

  const aug = augmentRubric(defaultRubric, [
    { id: "error-handling", description: "Error cases handled.", required: true }, // asked required…
    { id: "correctness", description: "shadow the base", required: false }, // …base id must be dropped
  ]);
  const eh = aug.criteria.find((c) => c.id === "error-handling")!;
  ok(!!eh && eh.required === false, "an extra criterion is forced OPTIONAL even if it asked to be required");
  ok(
    aug.criteria.filter((c) => c.id === "correctness").length === 1 &&
      aug.criteria.find((c) => c.id === "correctness")!.description === defaultRubric.criteria[0]!.description,
    "an extra can't shadow or overwrite a base criterion (base wins)",
  );
  ok(aug.passThreshold === defaultRubric.passThreshold, "the base pass threshold is preserved");
}

// ── 2. Proposer node: no-op when disabled ──
{
  const out = await makeProposeCriteriaNode(scriptedModel({ criteria: [{ id: "x", description: "y" }] }), {
    enabled: false,
  })(state());
  ok(Object.keys(out).length === 0, "disabled proposer is a pure no-op (no extraCriteria, no tokens, no messages)");
}

// ── 3. Proposer node: slugs ids, drops base + empties + dupes, caps, folds tokens ──
{
  const model = scriptedModel({
    criteria: [
      { id: "Error Handling", description: "Handles the empty-input case." }, // → slug 'error-handling'
      { id: "correctness", description: "dup of a base id" }, // dropped (base)
      { id: "error-handling", description: "dup id" }, // dropped (dupe)
      { id: "spacing", description: "   " }, // dropped (empty desc)
      { id: "no-secrets", description: "No secrets in logs." }, // kept
    ],
  });
  const out = await makeProposeCriteriaNode(model, { enabled: true })(state());
  const ec = out.extraCriteria ?? [];
  ok(ec.length === 2, "kept exactly the two valid, non-base, non-dupe criteria");
  ok(ec[0]!.id === "error-handling", "a non-kebab id is slugged to kebab-case");
  ok(ec.every((c) => c.required === false), "every proposed criterion is optional");
  ok(out.tokensUsed === 10 + 7, "the proposer folds its token usage");
  ok(!!out.messages?.[0]?.content.includes("empty-input"), "the proposal is surfaced as a visible note");
}

// ── 4. Proposer node: count is capped ──
{
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `crit-${i}`, description: `check ${i}` }));
  const out = await makeProposeCriteriaNode(scriptedModel({ criteria: many }), { enabled: true, max: 3 })(state());
  ok((out.extraCriteria ?? []).length === 3, "proposer caps the number of extra criteria at `max`");
}

// ── 5. Critic folds extras in and they NEVER gate a pass (optional-only) ──
{
  // Critic output: every BASE required met, high score, but the EXTRA is NOT met.
  const criticOut = {
    score: 95,
    criteria: [
      ...defaultRubric.criteria.map((c) => ({ id: c.id, met: true, note: "" })),
      { id: "error-handling", met: false, note: "missed an edge case" },
    ],
    issues: [],
  };
  const out = await makeCriticNode(scriptedModel(criticOut), defaultRubric)(
    state({ extraCriteria: [{ id: "error-handling", description: "Error cases handled.", required: false }] }),
  );
  const v = out.verdict!;
  ok(v.criteria!.some((c) => c.id === "error-handling"), "the adaptive criterion appears in the verdict the human sees");
  ok(v.criteria!.length === defaultRubric.criteria.length + 1, "verdict has one entry per effective (base + extra) criterion");
  ok(v.pass === true, "an UNMET optional extra does NOT block a pass (base required + score decide it)");
}

console.log("\nAdaptive Definition of Done (proposer + augmentRubric + critic) verified ✓");
