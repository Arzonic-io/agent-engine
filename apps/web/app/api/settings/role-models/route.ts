import { agentFetch } from "../../../lib/agent";

export const dynamic = "force-dynamic";

export async function PUT(req: Request): Promise<Response> {
  const body = await req.text();
  const res = await agentFetch("/settings/role-models", { method: "PUT", body });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
