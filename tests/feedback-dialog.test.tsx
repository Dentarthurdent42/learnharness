import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

/**
 * The user-report dialog (2026-11): SSR pins for the body's states and the
 * screenshot-fit math. Sending is live-verified against /api/feedback.
 */
import { FeedbackBody, fitWithin, type FeedbackBodyProps } from "../components/feedback-dialog.tsx";

const noop = () => {};
function body(over: Partial<FeedbackBodyProps> = {}): string {
	return renderToStaticMarkup(
		createElement(FeedbackBody, {
			fromMessage: true,
			kind: "bug",
			text: "",
			include: true,
			shots: [],
			busy: false,
			error: null,
			sent: false,
			onKind: noop,
			onText: noop,
			onInclude: noop,
			onAddShots: noop,
			onRemoveShot: noop,
			onSend: noop,
			onClose: noop,
			...over,
		}),
	);
}

describe("FeedbackBody", () => {
	it("from a message: titled Report a problem, include-conversation checkbox on", () => {
		const html = body();
		assert.match(html, /Report a problem/);
		assert.match(html, /data-testid="feedback-include"[^>]*checked/);
		assert.match(html, /Include this conversation/);
	});
	it("from the sidebar: titled Send feedback, no checkbox", () => {
		const html = body({ fromMessage: false });
		assert.match(html, /Send feedback/);
		assert.doesNotMatch(html, /feedback-include/);
	});
	it("Send is disabled until there's text, and shows Sending… while busy", () => {
		assert.match(body(), /data-testid="feedback-send"[^>]*disabled=""/);
		assert.doesNotMatch(body({ text: "broke" }), /data-testid="feedback-send"[^>]*disabled=""/);
		assert.match(body({ text: "broke", busy: true }), /Sending…/);
	});
	it("hides Add screenshot once 3 are attached", () => {
		assert.match(body(), /Add screenshot/);
		const shots = [{ preview: "blob:a" }, { preview: "blob:b" }, { preview: "blob:c" }];
		assert.doesNotMatch(body({ shots }), /Add screenshot/);
		assert.match(body({ shots }), /Remove screenshot 3/);
	});
	it("shows errors and the sent state", () => {
		assert.match(body({ error: "Too many" }), /role="alert"[^>]*>Too many/);
		const sent = body({ sent: true });
		assert.match(sent, /Thanks, sent\./);
		assert.doesNotMatch(sent, /feedback-text/);
	});
});

describe("fitWithin", () => {
	it("scales the longest edge to 1600 and never upscales", () => {
		assert.deepEqual(fitWithin(3200, 1600), { w: 1600, h: 800 });
		assert.deepEqual(fitWithin(1170, 2532), { w: 739, h: 1600 });
		assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600 });
	});
});
