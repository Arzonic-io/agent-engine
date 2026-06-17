import { spawn } from "node:child_process";

/**
 * The one place a verification command actually runs. Both consumers use it so
 * pass/fail can never diverge between them: `RepoTools.runCheck` formats the
 * result as a string for tool-using agents, while the mission `Verifier` reads
 * `passed` as the truth source for "done" (§5.4 of the design brief). Runs
 * `pnpm run <name>` with no shell, an allowlist, and a hard timeout — no
 * arbitrary execution.
 */

export const DEFAULT_ALLOWED_CHECKS = ["test", "lint", "typecheck", "build"];
export const CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_OUTPUT = 10_000;

/**
 * Executables an autonomous mission may run via `WritableRepoTools.runCommand`
 * (M2 build-order Trin 1). Bare names only — resolved on PATH, never a path with
 * separators — and run WITHOUT a shell, so `&&`/pipe/`$(...)` cannot interpolate.
 */
export const DEFAULT_ALLOWED_COMMANDS = ["git", "node", "pnpm", "npm", "npx"];

export interface CheckRun {
  /** false when `name` wasn't on the allowlist — the command was NOT executed. */
  allowed: boolean;
  /** true only when the check was allowed and exited 0. The truth source. */
  passed: boolean;
  /** Human status: "exit code N" | "timed out after …" | "not allowed" | "spawn error". */
  status: string;
  /** Combined stdout/stderr (untruncated; callers trim for display). */
  output: string;
}

export function truncateTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…(${s.length - max} chars of head truncated)\n${s.slice(-max)}`;
}

/**
 * Run one allowlisted check in `cwd`. Rejects unknown names without executing.
 * `passed` is derived from the real exit code, never from output text.
 */
export function runCheckProcess(
  cwd: string,
  name: string,
  allowedChecks: string[],
): Promise<CheckRun> {
  const clean = name.trim();
  if (!allowedChecks.includes(clean)) {
    return Promise.resolve({
      allowed: false,
      passed: false,
      status: "not allowed",
      output: `Check "${clean}" is not allowed. Allowed checks: ${allowedChecks.join(", ")}.`,
    });
  }
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["run", clean], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, CHECK_TIMEOUT_MS);
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        allowed: true,
        passed: false,
        status: "spawn error",
        output: `${output}\n${e.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const status = killed
        ? `timed out after ${CHECK_TIMEOUT_MS}ms`
        : `exit code ${code}`;
      resolve({ allowed: true, passed: !killed && code === 0, status, output });
    });
  });
}

export const INSTALL_TIMEOUT_MS = 600_000;

/**
 * Install dependencies in a fresh worktree so checks (`pnpm run …`) can run
 * (M2 build-order Trin 4). Uses pnpm, whose global content-addressable store is
 * shared across worktrees (hardlinks) — so per-worktree installs are cheap on
 * disk after the first. Returns the same shape as a check run; `passed=false`
 * means deps aren't ready and the item should not be treated as verifiable.
 */
export function installWorktreeDeps(
  cwd: string,
  timeoutMs: number = INSTALL_TIMEOUT_MS,
): Promise<CheckRun> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["install", "--prefer-offline"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ allowed: true, passed: false, status: "spawn error", output: `${output}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const status = killed ? `timed out after ${timeoutMs}ms` : `exit code ${code}`;
      resolve({ allowed: true, passed: !killed && code === 0, status, output });
    });
  });
}

export interface CommandRun {
  /** false when the executable wasn't on the allowlist — nothing was spawned. */
  allowed: boolean;
  /** true only when allowed and the process exited 0. */
  passed: boolean;
  /** "exit code N" | "timed out after …" | "not allowed" | "spawn error". */
  status: string;
  /** Combined stdout/stderr (untruncated; callers trim for display). */
  output: string;
}

/**
 * Run one allowlisted executable with literal arguments and NO shell, in `cwd`
 * (M2 build-order Trin 1, used by `WritableRepoTools.runCommand`). The command
 * must be a bare name on `allowedCommands` — a name containing a path separator
 * is rejected so an agent can't reach an executable outside the allowlist. With
 * `shell: false`, arguments are passed verbatim to the process, so `&&`, pipes
 * and `$(...)` are inert text, never interpreted.
 */
export function runAllowedCommand(
  cwd: string,
  command: string,
  args: string[],
  allowedCommands: string[],
): Promise<CommandRun> {
  const clean = command.trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || !allowedCommands.includes(clean)) {
    return Promise.resolve({
      allowed: false,
      passed: false,
      status: "not allowed",
      output: `Command "${command}" is not allowed. Allowed commands: ${allowedCommands.join(", ")}.`,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(clean, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, CHECK_TIMEOUT_MS);
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ allowed: true, passed: false, status: "spawn error", output: `${output}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const status = killed ? `timed out after ${CHECK_TIMEOUT_MS}ms` : `exit code ${code}`;
      resolve({ allowed: true, passed: !killed && code === 0, status, output });
    });
  });
}
