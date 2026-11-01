import { currentUser } from "@/tenancy";
import { AccountError, createLink, INVITE_TTL_MS, publicOrigin, RESET_TTL_MS, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Mint a one-time link for the admin to send by hand: an invite (a new
 *  account) or a password reset for an existing one. The raw token is in
 *  this response only — the store keeps its hash. */
async function handlePOST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { kind?: unknown; userId?: unknown };
	const kind = body.kind === "reset" ? "reset" : body.kind === "invite" ? "invite" : null;
	if (!kind) return Response.json({ error: 'kind must be "invite" or "reset"' }, { status: 400 });
	const userId = typeof body.userId === "string" ? body.userId : undefined;
	try {
		const token = createLink({ kind, createdBy: currentUser()!.userId, ...(kind === "reset" ? { userId } : {}) });
		const url = `${publicOrigin(req)}/${kind}/${encodeURIComponent(token)}`;
		return Response.json({ url, expiresAt: Date.now() + (kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS) });
	} catch (err) {
		if (err instanceof AccountError) return Response.json({ error: err.message, code: err.code }, { status: 404 });
		throw err;
	}
}

export const POST = withUser(handlePOST, { admin: true, cloudOnly: true });
