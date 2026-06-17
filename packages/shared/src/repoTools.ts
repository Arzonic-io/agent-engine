import { readdir, readFile as fsReadFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { RepoTools } from "@arzonic/agent-core";
import {
  DEFAULT_ALLOWED_CHECKS,
  MAX_CHECK_OUTPUT,
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
const MAX_SEARCH_HITS = 60;
const MAX_SEARCH_FILE_BYTES = 400_000;

export interface RepoToolsOptions {
  /** Command names runCheck may run via `pnpm run <name>`. Defaults to test/lint/typecheck/build. */
  allowedChecks?: string[];
}

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|sql|env|sh|css|scss|html|txt|toml|prisma|graphql)$/i;

/**
 * Read-only, path-sandboxed implementation of the core RepoTools contract.
 * Every path is resolved and verified to stay within `rootArg`; there is no
 * write capability and no command execution. Layer 1.
 */
export function createRepoTools(
  rootArg: string,
  options: RepoToolsOptions = {},
): RepoTools {
  const root = resolve(rootArg);
  const allowedChecks =
    options.allowedChecks && options.allowedChecks.length > 0
      ? options.allowedChecks
      : DEFAULT_ALLOWED_CHECKS;

  const within = (p: string): string => {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Path escapes repo root: ${p}`);
    }
    return abs;
  };

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

    async readFile(path) {
      const abs = within(path);
      const s = await stat(abs);
      if (s.isDirectory()) throw new Error(`${path} is a directory, not a file`);
      const buf = await fsReadFile(abs);
      const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
      return buf.length > MAX_FILE_BYTES
        ? `${text}\n…(truncated; file is ${buf.length} bytes)`
        : text;
    },

    async searchCode(query) {
      const needle = query.toLowerCase();
      const files: string[] = [];
      await walk(root, files);
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        let buf;
        try {
          buf = await fsReadFile(file);
        } catch {
          continue;
        }
        if (buf.length > MAX_SEARCH_FILE_BYTES) continue;
        const rel = relative(root, file);
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            if (hits.length >= MAX_SEARCH_HITS) break;
          }
        }
      }
      return hits.length
        ? hits.join("\n")
        : `No matches for "${query}".`;
    },

    async runCheck(name) {
      const clean = name.trim();
      const { allowed, status, output } = await runCheckProcess(root, clean, allowedChecks);
      if (!allowed) return output;
      return `$ pnpm run ${clean}\n(${status})\n\n${truncateTail(output.trim() || "(no output)", MAX_CHECK_OUTPUT)}`;
    },
  };
}
