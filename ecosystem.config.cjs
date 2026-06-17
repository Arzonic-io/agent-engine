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
  ],
};
