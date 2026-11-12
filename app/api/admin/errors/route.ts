import { errorLedger, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** The error ledger, grouped by fingerprint (most recently seen first).
 *  Admin-only: entries hold raw error text and tool arguments, which can
 *  contain learner content. ?fp=<fingerprint> returns that group's
 *  individual occurrences instead (newest first, up to ?limit=, default 50). */
async function handleGET(req: Request) {
	const url = new URL(req.url);
	const fp = url.searchParams.get("fp");
	if (fp) {
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
		const entries = errorLedger
			.readEntries()
			.filter((e) => e.fp === fp)
			.reverse()
			.slice(0, limit);
		return Response.json({ entries });
	}
	return Response.json({ groups: errorLedger.readGroups() });
}

export const GET = withUser(handleGET, { admin: true });
