/**
 * Throwaway proof that createMcpTools (M4) is BEST-EFFORT: MCP is an enhancement,
 * so an unset / blank / invalid config, or a server that can't start, must yield
 * an EMPTY toolset — never a thrown error that would sink a mission. No network,
 * no license: the "server that fails" is a local node process that exits non-zero.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-mcp.ts
 */
import { createMcpTools } from "./src/mcp.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const silent = () => {};

ok((await createMcpTools(undefined, silent)).tools.length === 0, "unset config → empty toolset");
ok((await createMcpTools("", silent)).tools.length === 0, "blank config → empty toolset");
ok((await createMcpTools("{not json", silent)).tools.length === 0, "invalid JSON → empty toolset (best-effort)");

// A server that fails to start (exits 1) must degrade to empty, never throw.
const bad = JSON.stringify({ mcpServers: { broken: { command: "node", args: ["-e", "process.exit(1)"] } } });
const res = await createMcpTools(bad, silent);
ok(res.tools.length === 0, "a server that fails to start → empty toolset, never throws");
await res.close();

// The claude_desktop_config shape ({ mcpServers }) AND a bare server map both parse
// without throwing (same failing command → both degrade to empty).
const bare = JSON.stringify({ broken: { command: "node", args: ["-e", "process.exit(1)"] } });
ok((await createMcpTools(bare, silent)).tools.length === 0, "a bare server map is accepted (no mcpServers wrapper)");

console.log("\nMCP factory best-effort behaviour verified ✓");
process.exit(0);
