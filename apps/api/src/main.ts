import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadApiEnv } from "./env.js";

// Bump on each deploy you want to verify went live — it prints in the boot log.
const APP_VERSION = "0.1.0";

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: env.API_CORS_ORIGINS.length > 0 ? env.API_CORS_ORIGINS : false,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, "0.0.0.0");
  console.log(
    `[agent-api] v${APP_VERSION} listening on :${env.API_PORT} | provider: ${env.LLM_PROVIDER} | ` +
      `checkpointer: ${env.SUPABASE_DB_URL ? "supabase/postgres" : "memory (dev only)"}`,
  );
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
