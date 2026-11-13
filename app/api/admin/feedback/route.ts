import { feedbackStore, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Every user report, newest first, with its GitHub issue number when
 *  filed. Admin-only: reports can include conversation excerpts.
 *  ?screenshot=<file> returns one screenshot image instead. */
async function handleGET(req: Request) {
	const url = new URL(req.url);
	const shot = url.searchParams.get("screenshot");
	if (shot) {
		try {
			const bytes = feedbackStore.readScreenshot(shot);
			const type = shot.endsWith(".png") ? "image/png" : shot.endsWith(".jpg") ? "image/jpeg" : "image/webp";
			return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
		} catch {
			return new Response(null, { status: 404 });
		}
	}
	const reports = feedbackStore
		.list()
		.reverse()
		.map((r) => ({ ...r, issue: feedbackStore.issueFor(r.id) ?? null }));
	return Response.json({ reports });
}

export const GET = withUser(handleGET, { admin: true });
