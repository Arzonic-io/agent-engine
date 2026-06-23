import { agentFetch } from "../../../../lib/agent";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const res = await agentFetch(`/missions/${encodeURIComponent(id)}/guidance`, {
    method: "PATCH",
    body: await req.text(),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
