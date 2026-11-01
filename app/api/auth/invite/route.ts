import { CLOUD_MODE } from "@/tenancy";
import { AccountError, createSession, crossOrigin, peekLink, redeemInvite, scopeOf, SESSION_TTL_MS, sessionCookie } from "@/src/server";

export const dynamic = "force-dynamic";

/** Is this invite link still usable? (The sign-up page's first check.) */
export async function GET(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	const token = new URL(req.url).searchParams.get("token") ?? "";
	return Response.json({ valid: peekLink(token)?.kind === "invite" });
}

/** Redeem an invite: create the account and sign it in. */
export async function POST(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	if (crossOrigin(req)) return Response.json({ error: "Cross-origin request refused", code: "cross_origin" }, { status: 403 });
	const body = (await req.json().catch(() => ({}))) as { token?: unknown; username?: unknown; password?: unknown };
	try {
		const user = await redeemInvite(
			typeof body.token === "string" ? body.token : "",
			typeof body.username === "string" ? body.username : "",
			typeof body.password === "string" ? body.password : "",
		);
		const token = createSession(user.id);
		return Response.json(
			{ ok: true, user: { username: scopeOf(user).username } },
			{ headers: { "Set-Cookie": sessionCookie(token, req, Math.floor(SESSION_TTL_MS / 1000)) } },
		);
	} catch (err) {
		if (err instanceof AccountError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
		throw err;
	}
}
