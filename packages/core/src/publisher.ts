import type { MissionDigest } from "./humanPolicy.js";
import type { Mission } from "./mission.js";

/**
 * Publish seam (overnight-trust: "del b" — get the work off the box). After a
 * mission ends, the controller hands its integration branch to a `Publisher`,
 * which pushes the branch to the remote and opens a pull request a human can
 * review in the morning. Pure interface — NO git, NO network here. The runtime
 * (`@arzonic/agent-shared`) supplies a concrete GitHub implementation and injects
 * it exactly like `Integrator`/`Notifier`, keeping `core` framework-free.
 *
 * Best-effort by contract: the controller calls it inside a guard, so a failed
 * publish (no remote, bad token, network down) is surfaced in the digest and
 * never crashes the mission or swallows the digest.
 */

export interface PublishInput {
  /** The mission being published — goal/acceptance/id for the PR title + body. */
  mission: Mission;
  /** The integration branch holding every merged item (e.g. `mission/<id>/integration`). */
  branch: string;
  /** The terminal digest, summarised into the PR body so a reviewer sees the rollup. */
  digest: MissionDigest;
}

export interface PublishResult {
  /** The pull-request URL, or null when there was nothing to publish (branch had no commits) or no remote. */
  url: string | null;
  /** One-line human note for the digest/journal — why there's no URL, or which PR was opened/reused. */
  note: string;
}

export interface Publisher {
  /**
   * Push `branch` to the remote and open (or reuse) a pull request targeting the
   * repo's default branch. Idempotent: a second call for a branch that already
   * has an open PR returns that PR rather than failing.
   */
  publish(input: PublishInput): Promise<PublishResult>;
}
