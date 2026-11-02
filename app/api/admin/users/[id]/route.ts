import { currentUser } from "@/tenancy";
import { AccountError, setUserDisabled, setUserLimit, summarize, withUser, type UserRecord } from "@/src/server";

export const dynamic = "force-dynamic";

/** Update one account: { disabled } (disabling ends its sessions; an admin
 *  can't disable themselves — that would lock the server out) and/or
 *  { limitUsd } (the allowance override; null = back to the default). */
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { disabled?: unknown; limitUsd?: unknown };
	const hasDisabled = body.disabled !== undefined;
	const hasLimit = body.limitUsd !== undefined;
	if (!hasDisabled && !hasLimit) return Response.json({ error: "Nothing to update" }, { status: 400 });
	if (hasDisabled && typeof body.disabled !== "boolean") return Response.json({ error: "disabled must be a boolean" }, { status: 400 });
	if (hasLimit && body.limitUsd !== null && typeof body.limitUsd !== "number") {
		return Response.json({ error: "limitUsd must be a number or null" }, { status: 400 });
	}
	if (body.disabled === true && id === currentUser()?.userId) {
		return Response.json({ error: "You can't disable your own account.", code: "self" }, { status: 400 });
	}
	try {
		let user: UserRecord | undefined;
		if (hasLimit) user = setUserLimit(id, body.limitUsd === null ? undefined : (body.limitUsd as number));
		if (hasDisabled) user = setUserDisabled(id, body.disabled as boolean);
		return Response.json({ user: summarize(user!) });
	} catch (err) {
		if (err instanceof AccountError) {
			return Response.json({ error: err.message, code: err.code }, { status: err.code === "not_found" ? 404 : 400 });
		}
		throw err;
	}
}

export const PATCH = withUser(handlePATCH, { admin: true, cloudOnly: true });
