/**
 * Live check that the google provider reaches Gemini via Vertex AI + Application
 * Default Credentials (ADC) — NO API key. Skips cleanly if GOOGLE_CLOUD_PROJECT is
 * unset. Proves buildModel picks ChatVertexAI for a project-configured google role
 * and that a real call authenticates through ADC.
 *
 * Requires: gcloud auth application-default login + GOOGLE_CLOUD_PROJECT in .env.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-vertex-live.ts
 */
import { loadEnv } from "./src/env.js";
import { buildModel } from "./src/llm.js";

const env = loadEnv();

if (!env.GOOGLE_CLOUD_PROJECT) {
  console.log("skip: GOOGLE_CLOUD_PROJECT not set — Vertex/ADC not configured.");
  process.exit(0);
}

const model = buildModel(env, { provider: "google", model: "gemini-2.5-flash" });
console.log(
  `Built google model via ${model.constructor.name} (project=${env.GOOGLE_CLOUD_PROJECT}, ` +
    `location=${env.GOOGLE_CLOUD_LOCATION}) — no API key.`,
);
if (model.constructor.name !== "ChatVertexAI") {
  throw new Error(`FAIL: expected ChatVertexAI, got ${model.constructor.name}`);
}

const res = await model.invoke("Reply with exactly the word: pong");
const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
console.log(`Vertex replied: ${text.trim()}`);
if (!/pong/i.test(text)) throw new Error(`FAIL: unexpected reply: ${text}`);

console.log("\n🎉 verify-vertex-live PASSED — Gemini via Vertex AI + ADC, no API key.\n");
