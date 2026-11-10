import { CLOUD_MODE } from "@/tenancy";
import { clearedSessionCookie, crossOrigin, deleteSession, sessionTokenFrom } from "@/src/server";

export const dynamic = "force-dynamic";

/** Sign out (cloud mode): end this session and clear the cookie. */
export async function POST(req: Request) {
	if (!CLOUD_MODE) return new Response(null, { status: 404 });
	if (crossOrigin(req)) return Response.json({ error: "Cross-origin request refused", code: "cross_origin" }, { status: 403 });
	const token = sessionTokenFrom(req);
	if (token) deleteSession(token);
	return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie(req) } });
}
