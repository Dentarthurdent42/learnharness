import { CLOUD_MODE, currentUser } from "@/tenancy";
import { withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Who am I? Desktop answers { cloud: false } (no accounts); cloud answers
 *  the signed-in user — the client hides admin-only surfaces (API keys,
 *  the admin page) from everyone else. */
async function handleGET() {
	if (!CLOUD_MODE) return Response.json({ cloud: false });
	const user = currentUser()!;
	return Response.json({ cloud: true, user: { username: user.username, role: user.role } });
}

export const GET = withUser(handleGET);
