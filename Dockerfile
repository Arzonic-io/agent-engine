# Optional container path — kept ready alongside the PM2 deploy.
# Build:  docker build -t agent-api .
# Run:    docker run --env-file .env -p 8787:8787 agent-api
# The app reads all config from env (API_PORT, AGENT_API_KEY, DATABASE_URL/SUPABASE_DB_URL,
# LLM provider keys), so nothing is baked into the image.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8787
CMD ["node", "apps/api/dist/main.js"]
