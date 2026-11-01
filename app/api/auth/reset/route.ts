import { CLOUD_MODE } from "@/tenancy";
import { AccountError, createSession, crossOrigin, getUser, peekLink, redeemReset, SESSION_TTL_MS, sessionCookie } from "@/src/server";

export const dynamic = "force-dynamic";

/** Is this reset link still usable, and for whom? */
export async function GET(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	const token = new URL(req.url).searchParams.get("token") ?? "";
	const link = peekLink(token);
	const user = link?.kind === "reset" && link.userId ? getUser(link.userId) : undefined;
	return Response.json(user ? { valid: true, username: user.username } : { valid: false });
}

/** Redeem a reset link: set the new password (every old session ends)
 *  and sign in. */
export async function POST(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	if (crossOrigin(req)) return Response.json({ error: "Cross-origin request refused", code: "cross_origin" }, { status: 403 });
	const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
	try {
		const user = await redeemReset(
			typeof body.token === "string" ? body.token : "",
			typeof body.password === "string" ? body.password : "",
		);
		const headers: HeadersInit = user.disabled
			? {}
			: { "Set-Cookie": sessionCookie(createSession(user.id), req, Math.floor(SESSION_TTL_MS / 1000)) };
		return Response.json({ ok: true, signedIn: !user.disabled }, { headers });
	} catch (err) {
		if (err instanceof AccountError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
		throw err;
	}
}
