/**
 * Tool contract for agents that work on a repo. Pure interface — NO I/O here.
 * The runtime (apps/cli, apps/api) supplies a concrete, sandboxed implementation
 * and injects it into the graph. This keeps `core` portable (Ranky can provide
 * its own implementation) while letting agents gain real capabilities.
 *
 * Layer 1 (read-only): list, read, search.
 * Layer 2 adds runCheck — running an allowlisted verification command (tests,
 * lint, typecheck, build). Still no writes and no arbitrary commands; the
 * runtime enforces the allowlist.
 *
 * Layer 3 (`WritableRepoTools`) adds the M2 write capability — writeFile /
 * applyEdit / deleteFile / runCommand. It is a SEPARATE interface, not optional
 * methods on `RepoTools`, so a read-only consumer (a task/builder run, the
 * analyst) is handed a `RepoTools` whose object literally has no write methods:
 * writes cannot leak into a non-mission flow. Mission execution is handed a
 * `WritableRepoTools`.
 */
/**
 * Optional line window for `readFile`. Reading a whole file costs tokens for the
 * WHOLE remaining agent loop — a ReAct transcript carries every earlier tool
 * result forward — so an agent that needs one function should page to it rather
 * than pull the file. Omitted = read from the start, up to the implementation's
 * default line budget.
 */
export interface ReadFileOptions {
  /** 1-based line to start at. Defaults to 1. */
  offset?: number;
  /** Maximum number of lines to return. Defaults to the implementation's budget. */
  limit?: number;
}

export interface RepoTools {
  /** List entries in a directory relative to the repo root (dirs end with "/"). */
  listFiles(dir: string): Promise<string>;
  /**
   * Read a UTF-8 file relative to the repo root, optionally a line window.
   * Implementations return line-numbered text and truncate; the returned text is
   * for reading, NOT for feeding back into an exact-match edit verbatim.
   */
  readFile(path: string, options?: ReadFileOptions): Promise<string>;
  /** Case-insensitive substring search across the repo; returns `path:line: text` hits. */
  searchCode(query: string): Promise<string>;
  /**
   * Run an allowlisted verification check (e.g. "test", "lint", "typecheck",
   * "build") in the repo and return its output + exit status. The runtime
   * rejects any name not on its allowlist — there is no arbitrary execution.
   */
  runCheck(name: string): Promise<string>;
}

/**
 * Write-capable repo tools for autonomous mission execution (M2, build-order
 * Trin 1). The implementation MUST keep every path confined to the repo/worktree
 * root (same sandbox as the read-only tools) and MUST run commands without a
 * shell, against an executable allowlist — no `&&`/pipe/`$(...)` interpolation.
 * All methods return a short human/agent-readable result string.
 */
export interface WritableRepoTools extends RepoTools {
  /**
   * Write (create or overwrite) a UTF-8 file relative to the root, creating
   * parent directories as needed. Path-confined to the root.
   */
  writeFile(path: string, content: string): Promise<string>;
  /**
   * Exact-match edit: replace the single occurrence of `oldString` with
   * `newString` in the file. Fails (without writing) if `oldString` is absent
   * or appears more than once — forcing the agent to disambiguate rather than
   * silently editing the wrong place.
   */
  applyEdit(path: string, oldString: string, newString: string): Promise<string>;
  /** Delete a file relative to the root. Path-confined; refuses directories. */
  deleteFile(path: string): Promise<string>;
  /**
   * Run an allowlisted executable with literal arguments (no shell), cwd = root.
   * The runtime rejects any executable not on its allowlist. Arguments are
   * passed verbatim to the process — there is no shell, so `&&`, pipes and
   * `$(...)` are inert. Returns the command, exit status and captured output.
   */
  runCommand(command: string, args?: string[]): Promise<string>;
}
