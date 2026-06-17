/**
 * Throwaway proof that the mission Verifier's pass/fail is the truth source:
 * a passing check ⇒ passed=true, a failing check ⇒ passed=false, an unknown
 * check is never a silent pass (§5.4, build-order Trin 2).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-verifier.ts
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier } from "./src/verifier.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const dir = await mkdtemp(join(tmpdir(), "verify-verifier-"));
try {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "verifier-fixture",
      scripts: {
        "good": "node -e \"process.exit(0)\"",
        "bad": "node -e \"console.error('boom'); process.exit(1)\"",
      },
    }),
  );

  const verifier = createVerifier(dir, { allowedChecks: ["good", "bad"] });

  const passing = await verifier.run(["good"]);
  ok(passing.passed, "a check that exits 0 ⇒ passed=true");

  const failing = await verifier.run(["bad"]);
  ok(!failing.passed, "a check that exits 1 ⇒ passed=false (a failing build keeps the item open)");
  ok(failing.results[0]!.output.includes("boom"), "failing output is captured for the next replan");

  const mixed = await verifier.run(["good", "bad"]);
  ok(!mixed.passed, "passed is the AND of all checks — one failure fails the report");
  ok(mixed.results.length === 2, "every check runs even after a failure (full picture for replan)");

  const unknown = await verifier.run(["deploy"]);
  ok(!unknown.passed, "a non-allowlisted check is a failure, never a silent pass");

  const none = await verifier.run([]);
  ok(!none.passed, "no checks requested ⇒ nothing verified ⇒ not done");

  console.log("\nVerifier pass/fail truth source verified ✓");
} finally {
  await rm(dir, { recursive: true, force: true });
}
