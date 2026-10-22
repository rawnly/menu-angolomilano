import { Data, Effect } from "effect";
import { CloudflareEnv } from "./types";

/**
 * Cloudflare Access JWT validation.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 *
 * Config (secrets / vars):
 *   ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com"
 *   ACCESS_AUD          the Application Audience (AUD) tag of the Access app
 *   DEV_AUTH_BYPASS     "1" in .dev.vars only, skips validation locally
 */
export type AccessEnv = Cloudflare.Env & {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	DEV_AUTH_BYPASS?: string;
};

export class AccessError extends Data.TaggedError("AccessError")<{
	reason: string;
	status: 401 | 403 | 500;
}> {}

export type AccessIdentity = { email: string };

type Jwk = JsonWebKey & { kid: string };

const b64urlToBytes = (s: string) => {
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const decodeJson = <T>(s: string): T =>
	JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;

// Module-level cache, lives as long as the isolate.
let jwksCache: { teamDomain: string; keys: Jwk[]; fetchedAt: number } | null =
	null;
const JWKS_TTL_MS = 60 * 60 * 1000;

const getKeys = async (teamDomain: string, force = false) => {
	if (
		!force &&
		jwksCache &&
		jwksCache.teamDomain === teamDomain &&
		Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
	) {
		return jwksCache.keys;
	}
	const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
	const { keys } = (await res.json()) as { keys: Jwk[] };
	jwksCache = { teamDomain, keys, fetchedAt: Date.now() };
	return keys;
};

const verify = async (
	token: string,
	teamDomain: string,
	aud: string,
): Promise<AccessIdentity> => {
	const fail = (reason: string, status: 401 | 403 = 401): never => {
		throw new AccessError({ reason, status });
	};

	const parts = token.split(".");
	if (parts.length !== 3) return fail("malformed token");
	const [h, p, s] = parts as [string, string, string];

	const header = decodeJson<{ alg: string; kid: string }>(h);
	if (header.alg !== "RS256") return fail("unsupported alg");

	let keys = await getKeys(teamDomain);
	let jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) {
		// Keys rotate; refetch once.
		keys = await getKeys(teamDomain, true);
		jwk = keys.find((k) => k.kid === header.kid);
	}
	if (!jwk) return fail("unknown key id");

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const ok = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		b64urlToBytes(s),
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) return fail("bad signature");

	const claims = decodeJson<{
		aud: string | string[];
		iss: string;
		exp: number;
		nbf?: number;
		email?: string;
	}>(p);
	const now = Date.now() / 1000;
	if (claims.exp <= now) return fail("token expired");
	if (claims.nbf && claims.nbf > now) return fail("token not yet valid");
	if (claims.iss !== `https://${teamDomain}`) return fail("bad issuer", 403);
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!auds.includes(aud)) return fail("bad audience", 403);
	if (!claims.email) return fail("no email claim", 403);

	return { email: claims.email };
};

export const requireAccess = (req: Request) =>
	Effect.gen(function* () {
		const env = (yield* CloudflareEnv) as AccessEnv;

		if (env.DEV_AUTH_BYPASS === "1") {
			return { email: "dev@localhost" } satisfies AccessIdentity;
		}
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
			return yield* new AccessError({
				reason: "access not configured",
				status: 500,
			});
		}
		const token = req.headers.get("Cf-Access-Jwt-Assertion");
		if (!token) {
			return yield* new AccessError({ reason: "missing token", status: 401 });
		}
		return yield* Effect.tryPromise({
			try: () => verify(token, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!),
			catch: (e) =>
				e instanceof AccessError
					? e
					: new AccessError({ reason: "verification failed", status: 401 }),
		});
	});
