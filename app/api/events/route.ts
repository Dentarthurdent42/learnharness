/**
 * THE NOTIFICATION CHANNEL ROUTE (push-architecture slice 1, 2026-10-02):
 * one SSE connection per open window over the core event bus — the
 * endpoint every future consumer (chat view, sidebar, activity dock)
 * subscribes to as the polls retire. The response plumbing lives in the
 * server seam (events-stream.ts); the framework route stays a thin
 * wrapper (the import law; tests drive the seam directly).
 */
import { eventsResponse, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

function handleGET(): Response {
	return eventsResponse();
}

// Cloud mode: signed-in users only, run in their data scope (src/server/auth.ts).
export const GET = withUser(handleGET);
