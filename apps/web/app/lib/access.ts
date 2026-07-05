import { jwtVerify, type JWTVerifyGetKey } from "jose";

/** What jose's `jwtVerify` accepts as its key source (v6: no `KeyLike` export). */
type VerifyKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

/**
 * Cloudflare Access app-level auth (M4 — defense in depth). The site sits behind
 * a Cloudflare Access (Zero Trust) tunnel, which authenticates the human at the
 * edge and forwards a SIGNED JWT (`Cf-Access-Jwt-Assertion`) + the user's email
 * (`Cf-Access-Authenticated-User-Email`) to the origin. This verifies that JWT so
 * the app itself refuses unauthenticated requests — closing the hole where someone
 * reaches the origin (:3400) directly, bypassing Cloudflare.
 *
 * Pure + framework-free (jose only) so the crypto is unit-testable; the Next
 * middleware is thin glue on top. Enforcement is OPT-IN via `WEB_AUTH=cloudflare`
 * + the two config vars — OFF by default so a misconfig can never lock anyone out
 * of a live site (Cloudflare Access is still in front regardless).
 */

export interface AccessConfig {
  /** The Zero Trust team domain, e.g. `bravy-app.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's AUD tag (its audience claim). */
  aud: string;
}

/** Enforcement is on only when explicitly enabled AND fully configured. */
export function authEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_AUTH === "cloudflare";
}

/** Read + validate the Cloudflare Access config from env; null if incomplete. */
export function accessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return null;
  return { teamDomain: teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, ""), aud };
}

/** The JWKS endpoint Cloudflare publishes its Access signing keys at. */
export function certsUrl(cfg: AccessConfig): string {
  return `https://${cfg.teamDomain}/cdn-cgi/access/certs`;
}

/** The Access issuer (the `iss` claim Cloudflare signs). */
export function issuer(cfg: AccessConfig): string {
  return `https://${cfg.teamDomain}`;
}

/** The Cloudflare Access logout URL — clears the Access session. */
export function logoutUrl(cfg: AccessConfig): string {
  return `https://${cfg.teamDomain}/cdn-cgi/access/logout`;
}

export interface AccessIdentity {
  email: string | null;
  sub: string | null;
}

/**
 * Verify a Cloudflare Access JWT against a key source (a remote JWKS in prod, a
 * local key in tests), the expected audience and issuer. Returns the identity on
 * success, or null on ANY failure (bad signature, wrong aud/iss, expired, malformed)
 * — the caller treats null as "deny", never throwing into the request path.
 */
export async function verifyAccessToken(
  token: string,
  key: VerifyKey,
  opts: { audience: string; issuer: string },
): Promise<AccessIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
      audience: opts.audience,
      issuer: opts.issuer,
    });
    const email = typeof payload.email === "string" ? payload.email : null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    return { email, sub };
  } catch {
    return null;
  }
}

/** The email Cloudflare Access forwards on every authenticated request (or null). */
export function readAccessEmail(headers: Headers): string | null {
  return headers.get("cf-access-authenticated-user-email") || null;
}

/** The Access JWT, from the header Cloudflare sets or its cookie fallback. */
export function readAccessToken(req: {
  headers: Headers;
  cookies?: { get: (n: string) => { value: string } | undefined };
}): string | null {
  return (
    req.headers.get("cf-access-jwt-assertion") ||
    req.cookies?.get("CF_Authorization")?.value ||
    null
  );
}
