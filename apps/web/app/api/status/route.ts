import { agentFetch } from "../../lib/agent";

export const dynamic = "force-dynamic";

/** Which server-side capabilities are configured (project memory, missions).
 * Lets the composer show a clear "activate memory" state instead of a raw 503. */
export async function GET(): Promise<Response> {
  const res = await agentFetch("/status");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
