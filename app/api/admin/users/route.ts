import { listUsers, summarize, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** The admin page's account list (no hashes). */
async function handleGET() {
	return Response.json({ users: listUsers().map(summarize) });
}

export const GET = withUser(handleGET, { admin: true, cloudOnly: true });
