import type { LhMessage } from "./native-messages.ts";
import { sessionMarkdown } from "./session-markdown.ts";

/**
 * USER REPORTS — the pure half (2026-11, owner-approved plan):
 * learners send a bug report or an idea from a flag on an agent turn or
 * from the sidebar. A report can carry up to MAX_SCREENSHOTS images and,
 * for message reports, an excerpt of the conversation (opt-out checkbox).
 */

export type FeedbackKind = "bug" | "idea";

export const FEEDBACK_TEXT_MAX = 5_000;
export const MAX_SCREENSHOTS = 3;
/** Decoded bytes per screenshot (the client shrinks to ≤1 MB first; this
 *  leaves headroom for encoders that overshoot slightly). */
export const SCREENSHOT_MAX_BYTES = 1_200_000;
export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];
/** Messages before / after the reported one in the excerpt. */
export const EXCERPT_BEFORE = 4;
export const EXCERPT_AFTER = 1;

export interface ScreenshotInput {
	type: ScreenshotType;
	/** base64, no data: prefix */
	data: string;
}

export interface FeedbackInput {
	kind: FeedbackKind;
	text: string;
	chatId?: string;
	messageId?: string;
	includeConversation: boolean;
	screenshots: ScreenshotInput[];
}

export class FeedbackInputError extends Error {}

function base64Bytes(b64: string): number {
	const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return Math.floor((b64.length * 3) / 4) - pad;
}

/** Validate an untrusted request body; throws FeedbackInputError. */
export function parseFeedbackInput(body: unknown): FeedbackInput {
	if (!body || typeof body !== "object") throw new FeedbackInputError("Invalid request body");
	const b = body as Record<string, unknown>;
	if (b.kind !== "bug" && b.kind !== "idea") throw new FeedbackInputError('kind must be "bug" or "idea"');
	const text = typeof b.text === "string" ? b.text.trim() : "";
	if (!text) throw new FeedbackInputError("Please describe the problem or idea.");
	if (text.length > FEEDBACK_TEXT_MAX) throw new FeedbackInputError(`Please keep it under ${FEEDBACK_TEXT_MAX} characters.`);
	const optId = (v: unknown, name: string): string | undefined => {
		if (v === undefined || v === null || v === "") return undefined;
		if (typeof v !== "string" || !/^[\w-]{1,128}$/.test(v)) throw new FeedbackInputError(`Invalid ${name}`);
		return v;
	};
	const chatId = optId(b.chatId, "chatId");
	const messageId = optId(b.messageId, "messageId");
	const rawShots = b.screenshots ?? [];
	if (!Array.isArray(rawShots)) throw new FeedbackInputError("screenshots must be a list");
	if (rawShots.length > MAX_SCREENSHOTS) throw new FeedbackInputError(`At most ${MAX_SCREENSHOTS} screenshots.`);
	const screenshots = rawShots.map((s, i): ScreenshotInput => {
		const shot = s as Record<string, unknown>;
		if (!SCREENSHOT_TYPES.includes(shot?.type as ScreenshotType)) throw new FeedbackInputError(`Screenshot ${i + 1}: unsupported image type`);
		if (typeof shot.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)) {
			throw new FeedbackInputError(`Screenshot ${i + 1}: invalid image data`);
		}
		if (base64Bytes(shot.data) > SCREENSHOT_MAX_BYTES) throw new FeedbackInputError(`Screenshot ${i + 1} is too large.`);
		return { type: shot.type as ScreenshotType, data: shot.data };
	});
	return {
		kind: b.kind,
		text,
		...(chatId ? { chatId } : {}),
		...(messageId ? { messageId } : {}),
		includeConversation: chatId !== undefined && b.includeConversation !== false,
		screenshots,
	};
}

export function screenshotExtension(type: ScreenshotType): string {
	return type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
}

/**
 * The conversation around the reported message as markdown: up to
 * EXCERPT_BEFORE messages before it, the message itself, and EXCERPT_AFTER
 * after (counted in record messages, so tool results count too). When the
 * message id isn't in the record (or none was given) the excerpt is the
 * chat's last EXCERPT_BEFORE + 1 messages.
 */
export function conversationExcerpt(messages: readonly LhMessage[], messageId?: string): string {
	const idx = messageId ? messages.findIndex((m) => (m as { id?: string }).id === messageId) : -1;
	const slice =
		idx >= 0
			? messages.slice(Math.max(0, idx - EXCERPT_BEFORE), idx + 1 + EXCERPT_AFTER)
			: messages.slice(-(EXCERPT_BEFORE + 1));
	return sessionMarkdown(slice, { anchors: true });
}

/** The model of the latest assistant message at or before the reported one. */
export function modelAt(messages: readonly LhMessage[], messageId?: string): string | undefined {
	const idx = messageId ? messages.findIndex((m) => (m as { id?: string }).id === messageId) : -1;
	const end = idx >= 0 ? idx + 1 : messages.length;
	for (let i = end - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; provider?: string; model?: string };
		if (m.role === "assistant" && m.model) return m.provider ? `${m.provider}:${m.model}` : m.model;
	}
	return undefined;
}
