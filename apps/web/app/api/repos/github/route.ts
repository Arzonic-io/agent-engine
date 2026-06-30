import { agentFetch } from "../../../lib/agent";

export const dynamic = "force-dynamic";

/** GitHub repos the configured token can push to — for the project repo picker. */
export async function GET(): Promise<Response> {
  const res = await agentFetch("/repos/github");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
