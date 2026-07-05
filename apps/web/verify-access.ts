/**
 * Throwaway proof of the Cloudflare Access JWT verification (M4 app-auth). Signs
 * tokens LOCALLY with a throwaway keypair (no network, no Cloudflare) so the
 * security-critical accept/deny logic is proven hermetically: a correctly-signed
 * token with the right aud + issuer is accepted; a wrong aud, wrong issuer,
 * expired, tampered, or missing token is REJECTED (null, never a throw).
 * Run: pnpm --filter @arzonic/agent-web exec tsx verify-access.ts
 */
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { accessConfig, authEnabled, verifyAccessToken } from "./app/lib/access.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const TEAM = "bravy-app.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "test-aud-tag-1234567890abcdef";
const EMAIL = "marc@arzonic.com";

async function main() {
const { publicKey, privateKey } = await generateKeyPair("RS256");
// A second, UNRELATED key — a token it signs must be rejected by our public key.
const other = await generateKeyPair("RS256");

const sign = (opts: {
  aud?: string;
  iss?: string;
  exp?: string;
  key?: CryptoKey;
  email?: string | null;
}) => {
  const jwt = new SignJWT({ ...(opts.email !== null ? { email: opts.email ?? EMAIL } : {}) })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? "1h");
  return jwt.sign(opts.key ?? privateKey);
};

const verify = (token: string) => verifyAccessToken(token, publicKey, { audience: AUD, issuer: ISS });

// 1. Happy path — correct signature, aud, issuer ⇒ accepted, email surfaced.
{
  const id = await verify(await sign({}));
  ok(id !== null, "a correctly-signed token with the right aud + issuer is accepted");
  ok(id?.email === EMAIL, "the user's email is read from the verified claims");
}

// 2. Wrong audience ⇒ rejected (this is the AUD-tag check that pins it to OUR app).
ok((await verify(await sign({ aud: "some-other-app" }))) === null, "a token for a DIFFERENT Access app (wrong aud) is rejected");

// 3. Wrong issuer ⇒ rejected.
ok((await verify(await sign({ iss: "https://evil.cloudflareaccess.com" }))) === null, "a token from a different team domain (wrong issuer) is rejected");

// 4. Expired ⇒ rejected.
ok((await verify(await sign({ exp: "-1m" }))) === null, "an expired token is rejected");

// 5. Signed by an UNRELATED key ⇒ rejected (signature doesn't match our JWKS).
ok((await verify(await sign({ key: other.privateKey }))) === null, "a token signed by the wrong key is rejected (bad signature)");

// 6. Tampered token ⇒ rejected.
{
  const t = await sign({});
  const tampered = t.slice(0, -3) + (t.endsWith("a") ? "bbb" : "aaa");
  ok((await verify(tampered)) === null, "a tampered token is rejected");
}

// 7. Empty / garbage token ⇒ rejected, never throws.
ok((await verify("")) === null, "an empty token is rejected");
ok((await verify("not.a.jwt")) === null, "a malformed token is rejected (no throw)");

// 8. A valid token with no email claim ⇒ accepted, email null.
{
  const id = await verify(await sign({ email: null }));
  ok(id !== null && id.email === null, "a token without an email claim still verifies (email null)");
}

// 9. Config helpers: parsing + the enable gate.
ok(accessConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD })?.teamDomain === TEAM, "accessConfig reads a complete config");
ok(
  accessConfig({ CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, CF_ACCESS_AUD: AUD })?.teamDomain === TEAM,
  "accessConfig strips scheme + trailing slash from the team domain",
);
ok(accessConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM } as NodeJS.ProcessEnv) === null, "accessConfig is null when the AUD is missing (never half-configured)");
ok(authEnabled({ WEB_AUTH: "cloudflare" } as NodeJS.ProcessEnv) === true, "authEnabled true only for WEB_AUTH=cloudflare");
ok(authEnabled({} as NodeJS.ProcessEnv) === false, "authEnabled false by default (opt-in — no accidental lockout)");

// Public-key JWK export sanity (the shape createRemoteJWKSet returns in prod).
ok((await exportJWK(publicKey)).kty === "RSA", "the verifying key is an RSA public key");

console.log("\nCloudflare Access JWT verification verified ✓");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
