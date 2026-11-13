import { FeedbackInputError, FeedbackRateLimitError, parseFeedbackInput, submitFeedback, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** A user's bug report or idea (any signed-in user). Body: { kind: "bug" |
 *  "idea", text, chatId?, messageId?, includeConversation?, screenshots?:
 *  [{ type, data(base64) }] }. Saved at once; filed to GitHub in the
 *  background when configured (docs/user-reports.md). */
async function handlePOST(req: Request) {
	const body = await req.json().catch(() => null);
	try {
		const { report } = submitFeedback(parseFeedbackInput(body));
		return Response.json({ ok: true, id: report.id });
	} catch (err) {
		if (err instanceof FeedbackInputError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof FeedbackRateLimitError) return Response.json({ error: err.message }, { status: 429 });
		throw err;
	}
}

export const POST = withUser(handlePOST);
