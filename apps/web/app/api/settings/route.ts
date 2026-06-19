import { agentFetch } from "../../lib/agent";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const res = await agentFetch("/settings");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
