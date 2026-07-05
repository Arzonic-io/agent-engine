import { headers } from "next/headers";
import { accessConfig, authEnabled, logoutUrl, readAccessEmail } from "../../lib/access";

export const dynamic = "force-dynamic";

/**
 * The signed-in identity for the UI. Reads the email Cloudflare Access forwards on
 * every authenticated request; null in local dev (no Access in front). `logout`
 * is the Access logout URL when configured. No secret is exposed — just who you are.
 */
export async function GET(): Promise<Response> {
  const h = await headers();
  const cfg = accessConfig();
  const body = {
    email: readAccessEmail(h),
    enforced: authEnabled() && cfg !== null,
    logout: cfg ? logoutUrl(cfg) : null,
  };
  return Response.json(body);
}
