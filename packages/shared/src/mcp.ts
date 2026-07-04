import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

/**
 * MCP (Model Context Protocol) tools for the mission implementer (M4). A mission
 * that builds UI can carry a permanent knowledge base — e.g. the daisyUI
 * blueprint server — by declaring MCP servers in `MISSION_MCP_SERVERS` (env). The
 * runtime connects to them ONCE at worker boot and hands their tools to the
 * implementer's ReAct belt, exactly like the write-tools; `core` stays framework-
 * free (it only ever receives ready tool objects).
 *
 * The env value is the SAME JSON shape as a Claude-Desktop `claude_desktop_config`
 * — `{ "mcpServers": { "<name>": { "command", "args", "env", "type"? } } }` — so a
 * config can be pasted straight in. A bare `{ "<name>": {...} }` map also works.
 *
 * Best-effort by contract: a parse error, a server that won't start (missing
 * license, npx offline), or a load failure yields an EMPTY tool set with a logged
 * warning — never a thrown error. MCP is an enhancement; missions must run without
 * it. `throwOnLoadError` is forced off so one bad server can't sink the rest.
 */
export interface McpToolset {
  tools: StructuredToolInterface[];
  /** Shut the MCP client + its child processes down (call on worker shutdown). */
  close: () => Promise<void>;
}

const EMPTY: McpToolset = { tools: [], close: async () => {} };

export async function createMcpTools(
  configJson: string | undefined,
  log: (line: string) => void = () => {},
): Promise<McpToolset> {
  if (!configJson || !configJson.trim()) return EMPTY;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson) as Record<string, unknown>;
  } catch (err) {
    log(`[mcp] MISSION_MCP_SERVERS is not valid JSON — ignoring. ${errText(err)}`);
    return EMPTY;
  }

  // Accept both the claude_desktop_config shape ({ mcpServers: {...} }) and a bare
  // server map. Force throwOnLoadError off so a single broken server degrades to
  // "that server's tools are absent", not "the whole toolset fails".
  const base = "mcpServers" in parsed ? parsed : { mcpServers: parsed };
  const config = { throwOnLoadError: false, ...base } as ConstructorParameters<
    typeof MultiServerMCPClient
  >[0];

  let client: MultiServerMCPClient;
  try {
    client = new MultiServerMCPClient(config);
    const tools = await client.getTools();
    log(
      tools.length > 0
        ? `[mcp] ${tools.length} tool(s) loaded: ${tools.map((t) => t.name).join(", ")}`
        : "[mcp] configured, but no tools were exposed by the server(s).",
    );
    return { tools, close: () => client.close() };
  } catch (err) {
    log(`[mcp] could not load MCP tools — running without them. ${errText(err)}`);
    try {
      await client!?.close();
    } catch {
      /* already down */
    }
    return EMPTY;
  }
}

function errText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
