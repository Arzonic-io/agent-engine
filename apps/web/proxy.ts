import { createRemoteJWKSet } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import {
  accessConfig,
  authEnabled,
  certsUrl,
  issuer,
  readAccessToken,
  verifyAccessToken,
} from "./app/lib/access";

/**
 * App-level auth (M4): verify the Cloudflare Access JWT on every request, so the
 * origin refuses anyone who didn't come through Access — defense in depth on top
 * of the edge tunnel. OPT-IN: a no-op unless `WEB_AUTH=cloudflare` AND the config
 * vars are set, so it can never lock a live site out by accident. Env is read at
 * BUILD (Next inlines it into the proxy bundle) — every deploy rebuilds, so
 * setting the vars in apps/web/.env.local + pushing turns it on.
 */

const cfg = accessConfig();
const enabled = authEnabled() && cfg !== null;
// Build the remote JWKS once (module scope) — cached across requests.
const jwks = enabled && cfg ? createRemoteJWKSet(new URL(certsUrl(cfg))) : null;

export async function proxy(req: NextRequest) {
  if (!enabled || !cfg || !jwks) return NextResponse.next();

  const token = readAccessToken(req);
  const identity = token
    ? await verifyAccessToken(token, jwks, { audience: cfg.aud, issuer: issuer(cfg) })
    : null;

  if (!identity) {
    // No valid Access JWT ⇒ the request didn't come through Cloudflare Access.
    // 401 rather than redirect: a legitimate user always arrives WITH the token.
    return new NextResponse("Unauthorized — Cloudflare Access required.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

// Guard pages + API routes; skip static assets, the favicon and images so the
// login/redirect chrome and public files are never gated.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.png|image.png|.*\\.(?:png|jpg|jpeg|svg|ico)$).*)"],
};
