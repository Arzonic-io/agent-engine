import { agentFetch } from "../../../../lib/agent";

export const dynamic = "force-dynamic";

/** A repo's open GitHub issues — for the "start a mission from an issue" picker. */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner") ?? "";
  const repo = searchParams.get("repo") ?? "";
  const res = await agentFetch(
    `/repos/github/issues?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
