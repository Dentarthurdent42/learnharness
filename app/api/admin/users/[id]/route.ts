import { currentUser } from "@/tenancy";
import { AccountError, setUserDisabled, summarize, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Disable / re-enable an account (disabling ends its sessions). An admin
 *  can't disable themselves — that would lock the server out. */
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { disabled?: unknown };
	if (typeof body.disabled !== "boolean") return Response.json({ error: "disabled must be a boolean" }, { status: 400 });
	if (body.disabled && id === currentUser()?.userId) {
		return Response.json({ error: "You can't disable your own account.", code: "self" }, { status: 400 });
	}
	try {
		return Response.json({ user: summarize(setUserDisabled(id, body.disabled)) });
	} catch (err) {
		if (err instanceof AccountError) return Response.json({ error: err.message, code: err.code }, { status: 404 });
		throw err;
	}
}

export const PATCH = withUser(handlePATCH, { admin: true, cloudOnly: true });
