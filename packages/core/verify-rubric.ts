/**
 * Throwaway proof of the per-project rubric floor: resolveProjectRubric must keep
 * the three universal required criteria present and `required`, no matter what the
 * client sent — while letting the operator tune the threshold, edit optional/base
 * text, add custom criteria, and drop optional ones. Pure, no deps.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-rubric.ts
 */
import {
  BASE_REQUIRED_CRITERIA,
  defaultRubric,
  resolveProjectRubric,
  RubricSchema,
  type Rubric,
} from "./src/rubric.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const BASE_IDS = BASE_REQUIRED_CRITERIA.map((c) => c.id);
const req = (r: Rubric, id: string) => r.criteria.find((c) => c.id === id);

// ── 1. An override that drops every required criterion still gets the floor back ──
{
  const stripped: Rubric = {
    passThreshold: 50,
    criteria: [{ id: "clarity", description: "Be clear.", required: false }],
  };
  const r = resolveProjectRubric(stripped);
  for (const id of BASE_IDS) {
    ok(!!req(r, id), `base required '${id}' is re-added when the client omitted it`);
    ok(req(r, id)!.required === true, `re-added '${id}' is required`);
  }
  ok(!!req(r, "clarity"), "the operator's own optional criterion survives");
  ok(r.passThreshold === 50, "the operator's pass threshold passes through");
}

// ── 2. A base criterion the client tried to downgrade to optional is forced back ──
{
  const downgraded: Rubric = {
    passThreshold: 80,
    criteria: BASE_REQUIRED_CRITERIA.map((c) => ({ ...c, required: false })),
  };
  const r = resolveProjectRubric(downgraded);
  ok(
    BASE_IDS.every((id) => req(r, id)!.required === true),
    "a base criterion sent as optional is forced back to required (can't be deselected)",
  );
}

// ── 3. Edited base text is kept; blanked base text falls back to canonical ──
{
  const edited: Rubric = {
    passThreshold: 90,
    criteria: [
      { id: "correctness", description: "Custom correctness wording.", required: true },
      { id: "completeness", description: "   ", required: true },
      { id: "matches-task", description: defaultRubric.criteria[2]!.description, required: true },
      { id: "custom-x", description: "No secrets in logs.", required: true },
    ],
  };
  const r = resolveProjectRubric(edited);
  ok(req(r, "correctness")!.description === "Custom correctness wording.", "edited base text is preserved");
  ok(
    req(r, "completeness")!.description === defaultRubric.criteria[1]!.description,
    "blank base text falls back to the canonical description",
  );
  ok(req(r, "custom-x")!.required === true, "a custom required criterion is honored");
  ok(r.passThreshold === 90, "threshold preserved");
}

// ── 4. Idempotent + duplicate ids collapse ──
{
  const once = resolveProjectRubric({
    passThreshold: 70,
    criteria: [
      { id: "correctness", description: "a", required: false },
      { id: "correctness", description: "b", required: false },
      { id: "extra", description: "an extra", required: false },
    ],
  });
  ok(once.criteria.filter((c) => c.id === "correctness").length === 1, "duplicate ids collapse to one");
  const twice = resolveProjectRubric(once);
  ok(JSON.stringify(once) === JSON.stringify(twice), "resolveProjectRubric is idempotent");
}

// ── 5. Threshold is clamped/rounded into 0–100 ──
{
  ok(resolveProjectRubric({ passThreshold: 150, criteria: [] }).passThreshold === 100, "threshold clamps to 100");
  ok(resolveProjectRubric({ passThreshold: -5, criteria: [] }).passThreshold === 0, "threshold clamps to 0");
}

// ── 6. The zod schema rejects malformed criteria (id casing, empty desc) ──
{
  ok(!RubricSchema.safeParse({ passThreshold: 80, criteria: [{ id: "Bad ID", description: "x", required: true }] }).success, "non-kebab id rejected");
  ok(!RubricSchema.safeParse({ passThreshold: 80, criteria: [{ id: "ok", description: "", required: true }] }).success, "empty description rejected");
  ok(RubricSchema.safeParse(defaultRubric).success, "the default rubric validates");
}

console.log("\nPer-project rubric floor + schema verified ✓");
