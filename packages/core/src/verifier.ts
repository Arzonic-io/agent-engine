import type { Verification } from "./mission.js";

/**
 * The verification capability the mission controller loop needs, as a pure
 * interface. The Tester/Verifier role (§5.4) runs the real allowlisted checks
 * against the repo; its `passed` is what decides "done" — not the LLM. The
 * runtime injects a concrete, sandboxed implementation (`createVerifier` in
 * `@arzonic/agent-shared`), keeping `core` framework-free.
 */

export interface VerifierReport {
  /** true only when EVERY requested check ran and passed. The truth source for "done". */
  passed: boolean;
  /** Per-check outcomes, in the order requested. */
  results: Verification[];
}

export interface Verifier {
  /**
   * Run the named checks (e.g. ["typecheck", "test"]) against the mission repo
   * and report pass/fail. Every check runs even if an earlier one fails, so the
   * replan step sees the full picture. `passed` is the AND of all results.
   */
  run(checks: string[]): Promise<VerifierReport>;
}
