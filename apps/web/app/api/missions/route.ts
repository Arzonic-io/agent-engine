import { agentFetch } from "../../lib/agent";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const res = await agentFetch("/missions");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  const res = await agentFetch("/missions", { method: "POST", body });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
