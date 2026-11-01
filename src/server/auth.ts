import { CLOUD_MODE, runAsUser, type UserScope } from "../../tenancy.ts";
import {
	createUser,
	dummyPasswordHash,
	findUserByUsername,
	getUser,
	listUsers,
	resolveSession,
	verifyPassword,
	type UserRecord,
} from "../store/accounts.ts";

/**
 * THE AUTH GATE (cloud mode, 2026-11). Every /api route and every
 * data-reading page runs inside withUser / pageUser: the session cookie
 * resolves to an account, and the handler runs in that user's tenancy
 * scope (tenancy.ts) — so the stores below it read and write only that
 * user's directory. No valid session → 401, never a fallback.
 *
 * Desktop (LH_MODE unset): both wrappers are pass-throughs — no login, no
 * cookie, behavior byte-for-byte as before.
 *
 * The Next proxy (proxy.ts) only REDIRECTS signed-out page loads to
 * /login for a smoother UX; it is not the gate (Next's own guidance —
 * authorization lives with the data access, here).
 */

export const SESSION_COOKIE = "lh_session";

export function scopeOf(user: UserRecord): UserScope {
	return { userId: user.id, username: user.username, role: user.role };
}

function cookieValue(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) {
			try {
				return decodeURIComponent(part.slice(eq + 1).trim());
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** The signed-in, enabled user for a session token, or undefined. */
export function userForToken(token: string | undefined): UserRecord | undefined {
	if (!token) return undefined;
	const session = resolveSession(token);
	if (!session) return undefined;
	const user = getUser(session.userId);
	return user && !user.disabled ? user : undefined;
}

export function sessionTokenFrom(req: Request): string | undefined {
	return cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
}

/** Is the request served over HTTPS (directly or behind Fly's edge)? */
export function isSecureRequest(req: Request): boolean {
	const forwarded = req.headers.get("x-forwarded-proto");
	if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
	return new URL(req.url).protocol === "https:";
}

export function sessionCookie(token: string, req: Request, maxAgeSeconds: number): string {
	return [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAgeSeconds}`,
		...(isSecureRequest(req) ? ["Secure"] : []),
	].join("; ");
}

export function clearedSessionCookie(req: Request): string {
	return sessionCookie("", req, 0);
}

/**
 * Cross-site request refusal for state-changing methods: the SameSite=Lax
 * cookie already stays home on cross-site POSTs; this checks Origin too
 * (belt and braces — and it covers same-site-but-cross-origin callers).
 */
export function crossOrigin(req: Request): boolean {
	if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
	const origin = req.headers.get("origin");
	if (!origin) return false;
	const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
	try {
		return new URL(origin).host !== host;
	} catch {
		return true;
	}
}

function deny(status: 401 | 403, code: string, error: string): Response {
	return Response.json({ error, code }, { status });
}

/**
 * Wrap a route handler: cloud mode resolves the caller and runs the
 * handler in their scope (admin: true additionally requires the admin
 * role). Desktop: the handler itself — or 404 for cloudOnly routes (the
 * account admin surface has nothing to administer on a desktop).
 */
export function withUser<A extends unknown[]>(
	handler: (req: Request, ...rest: A) => Response | Promise<Response>,
	opts: { admin?: boolean; cloudOnly?: boolean } = {},
): (req: Request, ...rest: A) => Promise<Response> {
	return async (req: Request, ...rest: A) => {
		if (!CLOUD_MODE) return opts.cloudOnly ? new Response(null, { status: 404 }) : handler(req, ...rest);
		if (crossOrigin(req)) return deny(403, "cross_origin", "Cross-origin request refused");
		await ensureBootstrapAdmin();
		const user = userForToken(sessionTokenFrom(req));
		if (!user) return deny(401, "unauthenticated", "Sign in required");
		if (opts.admin && user.role !== "admin") return deny(403, "forbidden", "Admins only");
		return runAsUser(scopeOf(user), () => handler(req, ...rest));
	};
}

// ─── login throttle ──────────────────────────────────────────────────────────
// Owner-approved default: 10 failed logins in 15 minutes blocks that
// username for 15 minutes. In-memory (a restart forgives — acceptable for
// a throttle; the scrypt cost is the standing defense).

const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;

interface LhThrottleGlobal {
	__lhLoginThrottle?: Map<string, { failures: number[]; blockedUntil: number }>;
}

function throttle(): Map<string, { failures: number[]; blockedUntil: number }> {
	const g = globalThis as typeof globalThis & LhThrottleGlobal;
	return (g.__lhLoginThrottle ??= new Map());
}

export function loginBlocked(usernameKey: string, now = Date.now()): boolean {
	return (throttle().get(usernameKey)?.blockedUntil ?? 0) > now;
}

function recordFailure(usernameKey: string, now: number): void {
	const entry = throttle().get(usernameKey) ?? { failures: [], blockedUntil: 0 };
	entry.failures = [...entry.failures.filter((t) => now - t < FAIL_WINDOW_MS), now];
	if (entry.failures.length >= FAIL_LIMIT) {
		entry.blockedUntil = now + BLOCK_MS;
		entry.failures = [];
	}
	throttle().set(usernameKey, entry);
}

export type LoginResult = { ok: true; user: UserRecord } | { ok: false; reason: "invalid" | "blocked" };

/** Check a username + password. Unknown users cost the same scrypt work
 *  as known ones (no username probing by timing). */
export async function checkLogin(username: string, password: string, now = Date.now()): Promise<LoginResult> {
	const key = username.trim().toLowerCase();
	if (loginBlocked(key, now)) return { ok: false, reason: "blocked" };
	await ensureBootstrapAdmin();
	const user = findUserByUsername(username);
	const ok = password.length <= 1024 && (await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash())));
	if (!ok || !user || user.disabled) {
		recordFailure(key, now);
		return { ok: false, reason: "invalid" };
	}
	throttle().delete(key);
	return { ok: true, user };
}

// ─── the first admin ─────────────────────────────────────────────────────────

let bootstrap: Promise<void> | undefined;

/**
 * First boot: with no accounts yet, LH_ADMIN_USERNAME + LH_ADMIN_PASSWORD
 * (Fly secrets) create the admin. Once any account exists these variables
 * are ignored — rotating them never resets anything.
 */
export function ensureBootstrapAdmin(): Promise<void> {
	return (bootstrap ??= (async () => {
		if (listUsers().length > 0) return;
		const username = process.env.LH_ADMIN_USERNAME;
		const password = process.env.LH_ADMIN_PASSWORD;
		if (!username || !password) {
			console.warn("[auth] no accounts exist and LH_ADMIN_USERNAME / LH_ADMIN_PASSWORD are not set — nobody can sign in");
			bootstrap = undefined; // retry on the next request (the secrets may be set later)
			return;
		}
		await createUser({ username, password, role: "admin" });
		console.log(`[auth] created the first admin account "${username}"`);
	})().catch((err: unknown) => {
		bootstrap = undefined;
		console.error("[auth] creating the first admin failed:", err);
	}));
}

/** The public origin the browser used (behind Fly's proxy: the forwarded
 *  host/proto) — the base for the invite/reset links the admin copies. */
export function publicOrigin(req: Request): string {
	const url = new URL(req.url);
	const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
	return `${isSecureRequest(req) ? "https" : "http"}://${host}`;
}
