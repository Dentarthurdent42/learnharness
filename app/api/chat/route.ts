import { handleChatRequest, withUser } from "@/src/server";

async function handlePOST(req: Request) {
	return handleChatRequest(req);
}

// Cloud mode: signed-in users only, run in their data scope (src/server/auth.ts).
export const POST = withUser(handlePOST);
