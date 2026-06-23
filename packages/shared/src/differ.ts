import type { Differ, DiffFile, DiffResult } from "@arzonic/agent-core";
import { runGit } from "./git.js";

/** Cap the stored patch so one giant item can't bloat the row / SSE snapshot. */
const DEFAULT_MAX_PATCH_BYTES = 100_000;

/**
 * git-backed `Differ` (M3 Trin 5). Computes the structured diff of the
 * implementer's UNCOMMITTED changes in an item's worktree — the changed files
 * (with ±lines) plus the unified patch — so the dashboard can show a human what
 * an item wrote before they Godkend/Afvis it.
 *
 * Untracked (new) files are momentarily marked intent-to-add so they appear in
 * `git diff`, then reset back out — so the index is left exactly as it was and the
 * Integrator's later `add -A`/commit is unaffected. Tracked modifications and
 * deletions are read straight from the working-tree diff (never staged). Gitignored
 * build output (dist/, node_modules, …) is excluded via `--exclude-standard`. Pure
 * read-side git plumbing; the pass/fail truth stays with the Verifier.
 */
export function createGitDiffer(options: { maxPatchBytes?: number } = {}): Differ {
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  return {
    async diff(worktree: string): Promise<DiffResult> {
      // Surface untracked files in the diff without permanently staging them.
      const untracked = (
        await runGit(worktree, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"])
      ).output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (untracked.length) await runGit(worktree, ["add", "-N", "--", ...untracked]);
      try {
        // Diff against HEAD (not the bare worktree diff) so STAGED changes count
        // too — a writable agent can `git add`/`git mv`, and those must show or the
        // human would under-see what the Integrator's later `add -A` actually merges.
        const base = ["-c", "core.quotePath=false", "diff", "HEAD"];
        const numstat = (await runGit(worktree, [...base, "--numstat"])).output;
        const nameStatus = (await runGit(worktree, [...base, "--name-status"])).output;
        const raw = (await runGit(worktree, base)).output;
        const counts = parseNumstat(numstat);
        const files = parseNameStatus(nameStatus, counts);
        const additions = files.reduce((n, f) => n + f.additions, 0);
        const deletions = files.reduce((n, f) => n + f.deletions, 0);
        // Cap by BYTES (the column/SSE budget), not chars. Slice the byte buffer,
        // then drop a trailing replacement char if the cut split a multibyte
        // sequence — so the stored patch is always valid, byte-bounded UTF-8.
        const rawBytes = Buffer.from(raw, "utf8");
        const truncated = rawBytes.byteLength > maxPatchBytes;
        const patch = truncated
          ? new TextDecoder().decode(rawBytes.subarray(0, maxPatchBytes)).replace(/�+$/, "")
          : raw;
        return { files, additions, deletions, patch, truncated };
      } finally {
        // Restore the index to exactly what it was (drop the intent-to-add marks).
        if (untracked.length) await runGit(worktree, ["reset", "-q", "--", ...untracked]);
      }
    },
  };
}

/** `<additions>\t<deletions>\t<path>` per line; `-` counts mean a binary file. */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const a = cols[0]!;
    const d = cols[1]!;
    const path = cols.slice(2).join("\t");
    map.set(path, {
      additions: a === "-" ? 0 : Number.parseInt(a, 10) || 0,
      deletions: d === "-" ? 0 : Number.parseInt(d, 10) || 0,
    });
  }
  return map;
}

function statusOf(letter: string): DiffFile["status"] {
  if (letter.startsWith("A")) return "added";
  if (letter.startsWith("D")) return "deleted";
  if (letter.startsWith("R")) return "renamed";
  return "modified"; // M, T (type change), C (copy), …
}

/** `<status>\t<path>` per line; the (new) path is the last column. */
function parseNameStatus(
  out: string,
  counts: Map<string, { additions: number; deletions: number }>,
): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const status = statusOf(cols[0]!);
    const path = cols[cols.length - 1]!;
    const c = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ path, status, additions: c.additions, deletions: c.deletions });
  }
  return files;
}
