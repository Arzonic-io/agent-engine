import { agentFetch } from "../../../../../../lib/agent";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const { id, itemId } = await ctx.params;
  const res = await agentFetch(
    `/missions/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/diff`,
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
