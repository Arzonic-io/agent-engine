import { AGENT_BASE, AGENT_KEY } from "../../../../lib/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxies the upstream mission SSE snapshot stream to the browser (key added server-side). */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const upstream = await fetch(
    `${AGENT_BASE}/missions/${encodeURIComponent(id)}/stream`,
    { headers: { Authorization: `Bearer ${AGENT_KEY}` }, cache: "no-store" },
  );

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `event: error\ndata: {"type":"error","message":"upstream ${upstream.status}"}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
