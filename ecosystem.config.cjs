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
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
