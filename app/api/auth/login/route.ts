import { CLOUD_MODE } from "@/tenancy";
import { checkLogin, createSession, crossOrigin, SESSION_TTL_MS, sessionCookie } from "@/src/server";

export const dynamic = "force-dynamic";

/** Sign in (cloud mode): username + password → the session cookie. */
export async function POST(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	if (crossOrigin(req)) return Response.json({ error: "Cross-origin request refused", code: "cross_origin" }, { status: 403 });
	const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
	const username = typeof body.username === "string" ? body.username : "";
	const password = typeof body.password === "string" ? body.password : "";
	const result = await checkLogin(username, password);
	if (!result.ok) {
		return result.reason === "blocked"
			? Response.json({ error: "Too many failed attempts. Try again in 15 minutes.", code: "blocked" }, { status: 429 })
			: Response.json({ error: "Wrong username or password.", code: "invalid" }, { status: 401 });
	}
	const token = createSession(result.user.id);
	return Response.json(
		{ ok: true },
		{ headers: { "Set-Cookie": sessionCookie(token, req, Math.floor(SESSION_TTL_MS / 1000)) } },
	);
}
