import { agentFetch } from "../../../../lib/agent";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const res = await agentFetch(`/projects/${encodeURIComponent(id)}/rubric`);
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const res = await agentFetch(`/projects/${encodeURIComponent(id)}/rubric`, {
    method: "PUT",
    body: await req.text(),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
