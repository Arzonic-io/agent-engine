// PM2 process file. Usage on the VPS:
//   pnpm install && pnpm build
//   pm2 start ecosystem.config.cjs
// Env comes from the repo-root .env (loaded by the app itself) — no secrets here.
module.exports = {
  apps: [
    {
      name: "agent-api",
      script: "apps/api/dist/main.js",
      cwd: __dirname,
      // Single-instance fork (matches arzonic/ranky). NOT cluster: the service
      // holds per-run state in memory (RunsService event subjects), so it must
      // stay one process. Setting `instances` at all flips PM2 into cluster
      // mode, so we pin exec_mode explicitly instead.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // The autonomous-mission worker (§5.7). Separate process from the API,
      // sharing the same Postgres (checkpointer + backlog). Drives runMission for
      // every `running` mission. Single fork — concurrent missions are serialized.
      name: "agent-mission-worker",
      script: "apps/api/dist/mission-worker.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // The Next.js web UI (agents.arzonic.com → Cloudflare tunnel → :3400).
      // MUST be deployed here too: every deploy rebuilds .next, and a running
      // `next start` serving against a freshly rebuilt .next throws ChunkLoadError
      // / missing-chunk 500s until it's restarted. Run the Next CLI directly (no
      // PATH/pnpm dependency); cwd = apps/web so it loads .next + .env.local.
      name: "agent-web",
      script: __dirname + "/apps/web/node_modules/next/dist/bin/next",
      args: "start -p 3400",
      cwd: __dirname + "/apps/web",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
