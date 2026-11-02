import { EconomyError, switchBack, switchToEconomy, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Switch to the admin's economy preset ({ on: true, chatId? } — the open
 *  session and the default for new ones) or back ({ on: false }). */
async function handlePOST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { on?: unknown; chatId?: unknown };
	if (typeof body.on !== "boolean") return Response.json({ error: "on must be a boolean" }, { status: 400 });
	try {
		if (body.on) switchToEconomy(typeof body.chatId === "string" ? body.chatId : undefined);
		else switchBack();
		return Response.json({ ok: true });
	} catch (err) {
		if (err instanceof EconomyError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

export const POST = withUser(handlePOST, { cloudOnly: true });
