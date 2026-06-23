/**
 * Throwaway proof of the git-backed Differ (M3 Trin 5) against a REAL temp repo.
 * Proves: a structured diff of the implementer's UNCOMMITTED worktree changes —
 * modified + added + deleted files with correct ±counts and a unified patch — that
 * surfaces untracked files, excludes gitignored build output, caps an oversized
 * patch, and leaves the index exactly as it found it (so the Integrator's later
 * commit is unaffected).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-differ.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitDiffer } from "./src/differ.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const dir = mkdtempSync(join(tmpdir(), "verify-differ-"));
try {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  writeFileSync(join(dir, "keep.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "gone.ts"), "export const old = true;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");

  const differ = createGitDiffer();

  // 0. Clean tree ⇒ empty diff.
  {
    const d = await differ.diff(dir);
    ok(d.files.length === 0 && d.additions === 0 && d.deletions === 0, "clean worktree ⇒ empty diff");
    ok(d.patch === "" && !d.truncated, "clean worktree ⇒ empty patch, not truncated");
  }

  // Author changes: modify keep.ts, add new.ts (untracked), delete gone.ts, and
  // drop a gitignored build artifact that must NOT show up.
  writeFileSync(join(dir, "keep.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  writeFileSync(join(dir, "new.ts"), "export const n = 1;\nexport const m = 2;\n");
  rmSync(join(dir, "gone.ts"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "artifact.js"), "build output\n");

  const d = await differ.diff(dir);
  const byPath = new Map(d.files.map((f) => [f.path, f]));

  ok(byPath.get("keep.ts")?.status === "modified", "modified tracked file → status modified");
  ok(
    byPath.get("keep.ts")?.additions === 1 && byPath.get("keep.ts")?.deletions === 0,
    "modified file's ±counts are right (+1 / -0)",
  );
  ok(byPath.get("new.ts")?.status === "added", "untracked new file is surfaced as added");
  ok(byPath.get("new.ts")?.additions === 2, "new file counts all its lines as additions (+2)");
  ok(byPath.get("gone.ts")?.status === "deleted", "removed tracked file → status deleted");
  ok(byPath.get("gone.ts")?.deletions === 1, "deleted file's lines count as deletions (-1)");
  ok(!byPath.has("dist/artifact.js"), "gitignored build output is excluded from the diff");
  ok(d.files.length === 3, "exactly the three authored files appear (no ignored noise)");
  ok(d.additions === 3 && d.deletions === 1, "totals sum the per-file counts (+3 / -1)");
  ok(
    d.patch.includes("new.ts") && d.patch.includes("+export const n = 1;"),
    "the unified patch carries the new file's content",
  );
  ok(d.patch.includes("keep.ts"), "the patch includes the modified file");

  // The differ must not leave anything staged for the Integrator's later commit.
  ok(git(dir, "diff", "--cached", "--name-only").trim() === "", "the index is left clean — no intent-to-add leaks");
  // The authored changes survive in the worktree for the merge to commit.
  const status = git(dir, "status", "--porcelain").trim();
  ok(status.includes("new.ts") && status.includes("keep.ts"), "the authored changes survive in the worktree");

  // Staged changes (an agent that ran `git add`) must still appear — we diff
  // against HEAD, not the bare worktree, so the human sees the full merged change.
  {
    git(dir, "add", "new.ts"); // fully stage one of the authored files
    const sd = await differ.diff(dir);
    const f = new Map(sd.files.map((x) => [x.path, x]));
    ok(f.get("new.ts")?.status === "added", "a STAGED new file still shows in the diff (vs HEAD, not bare worktree)");
    ok(f.get("keep.ts")?.status === "modified", "an unstaged change still shows alongside a staged one");
    git(dir, "reset", "-q"); // unstage so the truncation case below starts clean
  }

  // Truncation caps by BYTES and never emits a corrupt (split) multibyte char.
  {
    writeFileSync(join(dir, "big.ts"), "æ".repeat(200_000)); // 2 bytes per char
    const dd = await createGitDiffer({ maxPatchBytes: 1001 }).diff(dir);
    ok(dd.truncated, "an oversized patch is flagged truncated");
    ok(Buffer.byteLength(dd.patch) <= 1001, "the stored patch is byte-capped to maxPatchBytes");
    ok(!dd.patch.includes("�"), "truncation never leaves a corrupt split multibyte char");
  }

  console.log("\ngit Differ verified ✓");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
