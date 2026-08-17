import {
  mkdir,
  readdir,
  readFile as fsReadFile,
  stat,
  unlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { ReadFileOptions, RepoTools, WritableRepoTools } from "@arzonic/agent-core";
import {
  DEFAULT_ALLOWED_CHECKS,
  DEFAULT_ALLOWED_COMMANDS,
  MAX_CHECK_OUTPUT,
  runAllowedCommand,
  runCheckProcess,
  truncateTail,
} from "./checks.js";

/** Directories never worth reading — noise + huge. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  ".next",
  "coverage",
  ".cache",
  "build",
]);

const MAX_FILE_BYTES = 60_000;
/**
 * Default line window for `readFile` when the caller doesn't ask for one. A full
 * 60 KB file is ~15k tokens that then ride along in the ReAct transcript for
 * every remaining tool turn, so the default reads a window and tells the agent
 * how to page for the rest instead of paying that on the first `read_file`.
 * Most source files fit inside this and are still returned whole.
 */
const DEFAULT_READ_LINES = 400;
/** Ceiling on an explicit `limit` — a deliberate big read is allowed, unbounded isn't. */
const MAX_READ_LINES = 2_000;
/** Per-line cap, so one minified or generated line can't blow the whole window. */
const MAX_LINE_CHARS = 2_000;
const MAX_SEARCH_HITS = 60;
const MAX_SEARCH_FILE_BYTES = 400_000;
/**
 * Lines of context shown around each hit. A bare `path:line: text` hit tells an
 * agent WHERE something is but not whether it's the right place, so it follows up
 * with a read of the whole file — the expensive thing this tool exists to avoid.
 * A few lines of surrounding code usually answers the question outright.
 */
const SEARCH_CONTEXT_LINES = 3;
/** Overall cap on search output, since context multiplies every hit. */
const MAX_SEARCH_OUTPUT = 24_000;
const MAX_WRITE_BYTES = 1_000_000;

export interface RepoToolsOptions {
  /** Command names runCheck may run via `pnpm run <name>`. Defaults to test/lint/typecheck/build. */
  allowedChecks?: string[];
  /** Executables `runCommand` may spawn (writable tools only). Defaults to git/node/pnpm/npm/npx. */
  allowedCommands?: string[];
}

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|sql|env|sh|css|scss|html|txt|toml|prisma|graphql)$/i;

/**
 * Resolve+verify a repo-relative path stays inside `root`. Shared by the
 * read-only and write tools so writes can never escape the worktree root either.
 */
function makeWithin(root: string) {
  return (p: string): string => {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Path escapes repo root: ${p}`);
    }
    return abs;
  };
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") {
      // skip dotfiles/dirs except a couple useful ones
      if (e.isDirectory()) continue;
    }
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(resolve(dir, e.name), out);
    } else if (TEXT_EXT.test(e.name)) {
      out.push(resolve(dir, e.name));
    }
  }
}

/**
 * Render a line window of a file as numbered text, bounded by lines AND bytes.
 *
 * The `N→` prefix is display only: it makes hits from `searchCode` (which reports
 * `path:line:`) directly addressable and lets an agent page a big file, but it is
 * NOT part of the file. An exact-match edit built from this text verbatim will
 * fail to find its target — the tool descriptions and system prompts say so, and
 * `applyEdit`'s not-found error names this as the likely cause.
 *
 * Exported so the numbering, paging footer and both caps can be proven without
 * touching disk.
 */
export function renderFileWindow(
  path: string,
  buf: Buffer,
  options: ReadFileOptions = {},
): string {
  // Say so plainly — an empty file would otherwise render as a bare "1→", which
  // reads like a failed read rather than a real (and often meaningful) result.
  if (buf.length === 0) return "(empty file)";
  const lines = buf.toString("utf8").split("\n");
  // A file ending in a newline splits to a trailing "" that is not a real line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;

  const offset = Math.max(1, Math.trunc(options.offset ?? 1));
  const limit = Math.min(
    MAX_READ_LINES,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_READ_LINES)),
  );

  if (offset > total) {
    return `(no such lines: ${path} has ${total} line${total === 1 ? "" : "s"})`;
  }

  const wanted = Math.min(offset + limit - 1, total);
  // Width from the largest number we'll actually print — a 40-line file pays 2
  // columns of gutter, not 6.
  const width = String(wanted).length;

  const out: string[] = [];
  let bytes = 0;
  let last = offset - 1;
  for (let n = offset; n <= wanted; n++) {
    const raw = lines[n - 1]!;
    const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
    const rendered = `${String(n).padStart(width)}→${text}`;
    const size = Buffer.byteLength(rendered, "utf8") + 1;
    // Stop on the byte cap, but always emit at least one line so a file of very
    // long lines still returns something to page from.
    if (bytes + size > MAX_FILE_BYTES && out.length > 0) break;
    out.push(rendered);
    bytes += size;
    last = n;
  }

  if (last >= total) return out.join("\n");
  return `${out.join("\n")}\n…(showing lines ${offset}-${last} of ${total}; read on with offset=${last + 1})`;
}

/**
 * Turn hit line-indices into merged, non-overlapping context windows, clamped to
 * the file. Adjacent windows that touch are merged too, so a run of hits reads as
 * one continuous excerpt rather than repeating shared lines.
 * Exported for the same reason as `renderFileWindow` — provable without disk.
 */
export function mergeWindows(
  hits: number[],
  context: number,
  lineCount: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const h of hits) {
    const start = Math.max(0, h - context);
    const end = Math.min(lineCount - 1, h + context);
    const last = out[out.length - 1];
    // `<= last.end + 1` merges windows that merely touch, not just overlap —
    // otherwise two adjacent windows emit consecutive lines as separate blocks.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/** The read-only tool set (Layer 1 + 2), shared by both factories. */
function makeReadTools(
  root: string,
  within: (p: string) => string,
  allowedChecks: string[],
): RepoTools {
  return {
    async listFiles(dir) {
      const abs = within(dir || ".");
      const entries = await readdir(abs, { withFileTypes: true });
      const lines = entries
        .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.length ? lines.join("\n") : "(empty)";
    },

    async readFile(path, options) {
      const abs = within(path);
      const s = await stat(abs);
      if (s.isDirectory()) throw new Error(`${path} is a directory, not a file`);
      const buf = await fsReadFile(abs);
      return renderFileWindow(path, buf, options);
    },

    async searchCode(query, options) {
      const context = Math.max(0, Math.trunc(options?.context ?? SEARCH_CONTEXT_LINES));
      const needle = query.toLowerCase();
      const files: string[] = [];
      await walk(root, files);
      const blocks: string[] = [];
      let hitCount = 0;
      let bytes = 0;
      let truncated = false;

      outer: for (const file of files) {
        if (hitCount >= MAX_SEARCH_HITS) break;
        let buf;
        try {
          buf = await fsReadFile(file);
        } catch {
          continue;
        }
        if (buf.length > MAX_SEARCH_FILE_BYTES) continue;
        const rel = relative(root, file);
        const lines = buf.toString("utf8").split("\n");

        // Collect this file's hit lines first, then merge them into windows —
        // several hits inside one function would otherwise repeat the same
        // surrounding lines once per hit.
        const matched: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(needle)) matched.push(i);
        }
        if (matched.length === 0) continue;

        for (const window of mergeWindows(matched, context, lines.length)) {
          if (hitCount >= MAX_SEARCH_HITS) break outer;
          const hitsHere = matched.filter((m) => m >= window.start && m <= window.end);
          const width = String(window.end + 1).length;
          const body = [];
          for (let n = window.start; n <= window.end; n++) {
            // ':' marks the matching line, '-' its context — the same convention
            // as grep, so a hit stays greppable while the context reads as context.
            const sep = hitsHere.includes(n) ? ":" : "-";
            body.push(`${rel}:${String(n + 1).padStart(width)}${sep} ${lines[n]!.trim().slice(0, 200)}`);
          }
          const block = body.join("\n");
          const size = Buffer.byteLength(block, "utf8") + 2;
          if (bytes + size > MAX_SEARCH_OUTPUT && blocks.length > 0) {
            truncated = true;
            break outer;
          }
          blocks.push(block);
          bytes += size;
          hitCount += hitsHere.length;
        }
      }

      if (blocks.length === 0) return `No matches for "${query}".`;
      // Blank lines separate excerpts so context reads as blocks — but at
      // context:0 there is nothing to separate, and a blank line after every hit
      // would double the cost of exactly the mode chosen to be cheap.
      const joined = blocks.join(context > 0 ? "\n\n" : "\n");
      const capped = truncated || hitCount >= MAX_SEARCH_HITS;
      // Never let a capped result read as an exhaustive one — an agent that
      // believes it saw every hit will confidently miss the call site that matters.
      return capped ? `${joined}\n\n…(more matches not shown — narrow the query)` : joined;
    },

    async runCheck(name) {
      const clean = name.trim();
      const { allowed, status, output } = await runCheckProcess(root, clean, allowedChecks);
      if (!allowed) return output;
      return `$ pnpm run ${clean}\n(${status})\n\n${truncateTail(output.trim() || "(no output)", MAX_CHECK_OUTPUT)}`;
    },
  };
}

function resolveAllowedChecks(options: RepoToolsOptions): string[] {
  return options.allowedChecks && options.allowedChecks.length > 0
    ? options.allowedChecks
    : DEFAULT_ALLOWED_CHECKS;
}

/**
 * Read-only, path-sandboxed implementation of the core RepoTools contract.
 * Every path is resolved and verified to stay within `rootArg`; there is no
 * write capability and no command execution. Layer 1 + 2.
 */
export function createRepoTools(
  rootArg: string,
  options: RepoToolsOptions = {},
): RepoTools {
  const root = resolve(rootArg);
  return makeReadTools(root, makeWithin(root), resolveAllowedChecks(options));
}

/**
 * Write-capable, path-sandboxed implementation of `WritableRepoTools` for
 * autonomous mission execution (M2 build-order Trin 1). Adds writeFile /
 * applyEdit / deleteFile / runCommand on top of the read-only tools. Writes are
 * confined to `rootArg` by the same `within` guard; `runCommand` runs an
 * allowlisted executable with NO shell (no `&&`/pipe/`$(...)` interpolation),
 * cwd = the root. Hand this only to mission flows — task/builder runs get the
 * read-only `createRepoTools` so writes can't leak into them.
 */
export function createWritableRepoTools(
  rootArg: string,
  options: RepoToolsOptions = {},
): WritableRepoTools {
  const root = resolve(rootArg);
  const within = makeWithin(root);
  const allowedCommands =
    options.allowedCommands && options.allowedCommands.length > 0
      ? options.allowedCommands
      : DEFAULT_ALLOWED_COMMANDS;

  return {
    ...makeReadTools(root, within, resolveAllowedChecks(options)),

    async writeFile(path, content) {
      const abs = within(path);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error(`Refusing to write ${bytes} bytes to ${path} (max ${MAX_WRITE_BYTES}).`);
      }
      try {
        const s = await stat(abs);
        if (s.isDirectory()) throw new Error(`${path} is a directory, not a file`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await mkdir(dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, "utf8");
      return `Wrote ${bytes} bytes to ${path}`;
    },

    async applyEdit(path, oldString, newString) {
      const abs = within(path);
      const s = await stat(abs);
      if (s.isDirectory()) throw new Error(`${path} is a directory, not a file`);
      const current = await fsReadFile(abs, "utf8");
      if (oldString === newString) {
        throw new Error(`applyEdit on ${path}: oldString and newString are identical — no change.`);
      }
      const first = current.indexOf(oldString);
      if (first === -1) {
        // `readFile` returns "  12→code" for navigability. Copying that back as
        // oldString is the single most likely cause of a miss, so name it here —
        // the agent then self-corrects on its next turn instead of re-guessing.
        const numbered = /^\s*\d+→/m.test(oldString)
          ? " oldString still carries the 'N→' line-number prefixes from read_file — strip them; they are not in the file."
          : "";
        throw new Error(`applyEdit on ${path}: oldString not found.${numbered}`);
      }
      if (current.indexOf(oldString, first + 1) !== -1) {
        throw new Error(
          `applyEdit on ${path}: oldString appears more than once — add surrounding context to make it unique.`,
        );
      }
      const next = current.slice(0, first) + newString + current.slice(first + oldString.length);
      await fsWriteFile(abs, next, "utf8");
      return `Edited ${path} (1 replacement)`;
    },

    async deleteFile(path) {
      const abs = within(path);
      const s = await stat(abs);
      if (s.isDirectory()) throw new Error(`${path} is a directory, not a file`);
      await unlink(abs);
      return `Deleted ${path}`;
    },

    async runCommand(command, args = []) {
      const { allowed, status, output } = await runAllowedCommand(root, command, args, allowedCommands);
      const shown = `${command}${args.length ? ` ${args.join(" ")}` : ""}`;
      if (!allowed) return output;
      return `$ ${shown}\n(${status})\n\n${truncateTail(output.trim() || "(no output)", MAX_CHECK_OUTPUT)}`;
    },
  };
}
