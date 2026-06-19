/**
 * Throwaway proof of the per-role model seam in core (M3 Trin 4): pickModel
 * resolves a role to its override when configured and to the fallback otherwise,
 * and every graph accepts a `models` map AND works without one (back-compat).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-role-models.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentGraph, createTeamGraph } from "./src/graph.js";
import { MODEL_ROLES, pickModel, type RoleModels } from "./src/models.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

// Tagged fakes. Some node factories call withStructuredOutput/bindTools at build
// time, so the fake returns itself for those (it is never invoked here).
const tag = (id: string) => {
  const m: Record<string, unknown> = { __id: id };
  m.withStructuredOutput = () => m;
  m.bindTools = () => m;
  m.invoke = async () => ({ content: "" });
  return m as unknown as BaseChatModel;
};
const fallback = tag("fallback");
const models: RoleModels = {
  critic: tag("gemini"),
  implementer: tag("claude"),
  architect: tag("mistral"),
};

// 1. Resolution — override wins where set, fallback everywhere else.
ok(pickModel(fallback, "critic", models) === models.critic, "critic resolves to its override (e.g. Gemini)");
ok(pickModel(fallback, "implementer", models) === models.implementer, "implementer resolves to its override (e.g. Claude)");
ok(pickModel(fallback, "architect", models) === models.architect, "architect resolves to its override (e.g. Mistral)");
ok(pickModel(fallback, "worker", models) === fallback, "an unassigned role falls back to the default model");
ok(pickModel(fallback, "lead", undefined) === fallback, "no map at all → always the fallback (back-compat)");

// 2. Every declared role is a clean key and is covered by the fallback.
for (const role of MODEL_ROLES) {
  ok(pickModel(fallback, role, {}) === fallback, `role '${role}' falls back cleanly with an empty map`);
}

// 3. Graphs compile WITH a models map and WITHOUT it — purely additive.
const cp = () => new MemorySaver();
ok(!!createTeamGraph({ model: fallback, models, checkpointer: cp() }), "team graph compiles with per-role models");
ok(!!createTeamGraph({ model: fallback, checkpointer: cp() }), "team graph compiles without models (back-compat)");
ok(!!createAgentGraph({ model: fallback, models, checkpointer: cp() }), "single graph compiles with per-role models");

console.log("\nPer-role model seam verified ✓");
