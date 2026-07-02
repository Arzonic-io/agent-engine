import { agentFetch } from "../../lib/agent";

export const dynamic = "force-dynamic";

/**
 * Local repo discovery for the pickers. On the cloud deploy set
 * `WEB_LOCAL_REPOS=off`: the browser can never reach the user's own disk, and
 * listing the VPS's filesystem is a footgun (it includes the live deployment
 * repo — a mission against it would check branches out in the running app's
 * working tree). The `x-local-repos: off` header tells the UI "disabled",
 * distinct from "no repos found" (dev with an empty allowed-root).
 */
export async function GET(): Promise<Response> {
  if (process.env.WEB_LOCAL_REPOS === "off") {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json", "x-local-repos": "off" },
    });
  }
  const res = await agentFetch("/repos");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
