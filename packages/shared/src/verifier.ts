import { resolve } from "node:path";
import type { Verifier, VerifierReport } from "@arzonic/agent-core";
import {
  DEFAULT_ALLOWED_CHECKS,
  MAX_CHECK_OUTPUT,
  runCheckProcess,
  truncateTail,
} from "./checks.js";

export interface VerifierOptions {
  /** Check names the Verifier may run via `pnpm run <name>`. Defaults to test/lint/typecheck/build. */
  allowedChecks?: string[];
}

/**
 * The mission Verifier — runs the real allowlisted checks against `repoPath` and
 * reports structured pass/fail (§5.4). It shares the exact command runner with
 * `RepoTools.runCheck` (see `checks.ts`), so what an agent sees and what decides
 * "done" can never diverge. A disallowed or non-executable check counts as a
 * failure, never a silent pass — the loop must treat "couldn't verify" as "not done".
 */
export function createVerifier(repoPath: string, options: VerifierOptions = {}): Verifier {
  const root = resolve(repoPath);
  const allowedChecks =
    options.allowedChecks && options.allowedChecks.length > 0
      ? options.allowedChecks
      : DEFAULT_ALLOWED_CHECKS;

  return {
    async run(checks): Promise<VerifierReport> {
      const results = [];
      for (const name of checks) {
        const clean = name.trim();
        const run = await runCheckProcess(root, clean, allowedChecks);
        results.push({
          passed: run.passed,
          check: clean,
          output: truncateTail(run.output.trim() || "(no output)", MAX_CHECK_OUTPUT),
        });
      }
      // No checks requested ⇒ nothing was verified ⇒ not "done".
      const passed = results.length > 0 && results.every((r) => r.passed);
      return { passed, results };
    },
  };
}
