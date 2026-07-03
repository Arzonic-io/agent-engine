#!/usr/bin/env node
/**
 * Turnkey mission launcher — point the running stack at a REAL repo and let it work.
 *
 * The mission-worker already polls for running missions, so all this does is create
 * a project (bound to your repo) + a mission via the API; the worker then picks it
 * up and runs it overnight. Watch it on the dashboard, review the draft PR in the
 * morning. This is the "does it carry water on my repo?" run (backlog #4) — the
 * step that turns "every seam is green" into real, mergeable output.
 *
 * Prereqs: the stack is up (`pnpm dev`, or PM2 in prod) with SUPABASE_DB_URL + a
 * model key configured, and (for a GitHub repo / draft PR) GITHUB_TOKEN.
 *
 * Configure via env (or export them in your shell first):
 *   AGENT_API_URL   API base            (default http://127.0.0.1:8787)
 *   AGENT_API_KEY   bearer key          (required)
 *   WEB_URL         web base for links  (default http://127.0.0.1:3400)
 *   MISSION_PROJECT_ID    reuse an existing project (skips project creation)
 *   MISSION_PROJECT_NAME  new project name        (default: derived from repo/goal)
 *   MISSION_PROJECT_BRIEF new project brief        (optional)
 *   MISSION_GITHUB        owner/repo to bind       (preferred; enables draft PRs)
 *   MISSION_REPO          local repo path to bind  (alternative to MISSION_GITHUB)
 *   MISSION_GOAL          what the mission achieves (required)
 *   MISSION_CRITERIA      acceptance criteria, one per line or ';'-separated
 *   MISSION_CHECKS        verification checks, comma-separated (e.g. typecheck,test)
 *   MISSION_BUDGET        token budget (number; omit = unbounded)
 *   MISSION_DEADLINE      ISO stop-by time (optional)
 *
 * Run: node scripts/launch-mission.mjs   (or: pnpm mission)
 */

const API = (process.env.AGENT_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const WEB = (process.env.WEB_URL ?? "http://127.0.0.1:3400").replace(/\/+$/, "");
const KEY = process.env.AGENT_API_KEY ?? "";

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(`Could not reach the API at ${API} — is the stack running (\`pnpm dev\`)?\n  ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) die(`POST ${path} → ${res.status}\n  ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Split on any of the given separator chars, trimming + dropping empties. */
function splitList(v, seps = ",") {
  return (v ?? "")
    .split(new RegExp(`[${seps}]`))
    .map((s) => s.trim())
    .filter(Boolean);
}

if (!KEY) die("Set AGENT_API_KEY (the API bearer key) first.");
const goal = process.env.MISSION_GOAL?.trim();
if (!goal) die("Set MISSION_GOAL (what the mission should achieve).");

const github = process.env.MISSION_GITHUB?.trim();
const repoPath = process.env.MISSION_REPO?.trim();
let projectId = process.env.MISSION_PROJECT_ID?.trim();

// 1) Project — reuse an existing one, or create a new one bound to the repo.
if (!projectId) {
  if (!github && !repoPath) {
    die("Bind a repo: set MISSION_GITHUB=owner/repo (preferred) or MISSION_REPO=/path, or reuse MISSION_PROJECT_ID.");
  }
  const body = {
    name: process.env.MISSION_PROJECT_NAME?.trim() || (github ?? goal.slice(0, 40)),
    brief: process.env.MISSION_PROJECT_BRIEF?.trim() || "",
  };
  if (github) {
    const [owner, repo] = github.split("/");
    if (!owner || !repo) die(`MISSION_GITHUB must be "owner/repo" (got "${github}").`);
    body.githubRepo = { owner, repo };
  } else {
    body.repoPath = repoPath;
  }
  console.log(`→ creating project "${body.name}"${github ? ` (github: ${github})` : ` (path: ${repoPath})`}…`);
  const project = await api("/projects", body);
  projectId = project.id;
  console.log(`  project ${projectId}`);
} else {
  console.log(`→ reusing project ${projectId}`);
}

// 2) Mission — the worker picks it up on its next poll.
const mission = {
  projectId,
  goal,
  // The API re-derives the bound repo from the project; send it for older builds too.
  repoPath: repoPath || undefined,
  acceptanceCriteria: splitList(process.env.MISSION_CRITERIA, "\\n;"),
  checks: splitList(process.env.MISSION_CHECKS, ","),
  budget: process.env.MISSION_BUDGET ? Number(process.env.MISSION_BUDGET) : null,
  deadline: process.env.MISSION_DEADLINE?.trim() || null,
};
// The API validates repoPath; if we don't have one locally, let it inherit the project's.
if (!mission.repoPath) {
  // Fetch the project to get its bound repoPath (missions require one).
  const got = await fetch(`${API}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (got.ok) {
    const p = await got.json();
    mission.repoPath = p?.settings?.repoPath;
  }
  if (!mission.repoPath) die("The project has no bound repo — bind one first (MISSION_GITHUB / MISSION_REPO).");
}

console.log(`→ launching mission…`);
const created = await api("/missions", mission);
const url = `${WEB}/missions/${created.id}`;
console.log(`\n✔ Mission launched: ${created.id}`);
console.log(`  Goal:    ${goal}`);
if (mission.checks.length) console.log(`  Checks:  ${mission.checks.join(", ")}`);
console.log(`  Budget:  ${mission.budget ?? "unbounded"}`);
console.log(`\n  Watch it:  ${url}`);
console.log(`  The worker starts it on its next poll. Review the draft PR when it stops.\n`);
