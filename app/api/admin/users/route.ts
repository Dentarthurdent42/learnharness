import { runAsUser } from "@/tenancy";
import { currentAllowance, listUsers, scopeOf, summarize, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** The admin page's account list (no hashes), each with its current
 *  allowance use — read inside that user's own data scope. */
async function handleGET() {
	const now = Date.now();
	return Response.json({
		users: listUsers().map((u) => {
			const allowance = runAsUser(scopeOf(u), () => currentAllowance(now));
			return { ...summarize(u), allowance: { fraction: allowance.fraction, limitUsd: allowance.limitUsd } };
		}),
	});
}

export const GET = withUser(handleGET, { admin: true, cloudOnly: true });
