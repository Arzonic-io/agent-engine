import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Env } from "@arzonic/agent-shared";

export interface CheckpointerHandle {
  saver: BaseCheckpointSaver;
  persistent: boolean;
  close: () => Promise<void>;
}

/** Same policy as the CLI: Supabase/Postgres when SUPABASE_DB_URL is set, MemorySaver otherwise. */
export async function createCheckpointer(env: Env): Promise<CheckpointerHandle> {
  if (env.SUPABASE_DB_URL) {
    const saver = PostgresSaver.fromConnString(env.SUPABASE_DB_URL);
    await saver.setup();
    return { saver, persistent: true, close: () => saver.end() };
  }
  return {
    saver: new MemorySaver(),
    persistent: false,
    close: async () => {},
  };
}
