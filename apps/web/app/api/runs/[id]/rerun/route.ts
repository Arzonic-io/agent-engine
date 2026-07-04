import { agentFetch } from "../../../../lib/agent";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const body = await req.text();
  const res = await agentFetch(`/runs/${encodeURIComponent(id)}/rerun`, {
    method: "POST",
    body,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
