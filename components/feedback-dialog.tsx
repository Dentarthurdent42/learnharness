"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { FEEDBACK_TEXT_MAX, MAX_SCREENSHOTS, type FeedbackKind } from "@/src/core";

/**
 * USER REPORTS (2026-11, owner-approved plan): one dialog for both entry
 * points — the flag at the end of an agent turn (chatId + messageId:
 * the "Include this conversation" checkbox shows, on by default) and the
 * sidebar's "Send feedback" (no chat context). Bug or idea, a text box,
 * up to MAX_SCREENSHOTS screenshots (shrunk in the browser), Send, then
 * a thank-you. Where it goes: docs/user-reports.md.
 */

/** Longest edge and byte budget for a screenshot after shrinking. */
export const SHOT_MAX_EDGE = 1600;
export const SHOT_MAX_BYTES = 1_000_000;

export interface Shot {
	type: "image/jpeg" | "image/png";
	/** base64, no data: prefix */
	data: string;
	/** object URL for the thumbnail */
	preview: string;
}

/** Scale (w, h) so the longest edge is at most `max` (never upscales). */
export function fitWithin(w: number, h: number, max = SHOT_MAX_EDGE): { w: number; h: number } {
	const scale = Math.min(1, max / Math.max(w, h));
	return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** Shrink an image file to ≤SHOT_MAX_EDGE px and ≤SHOT_MAX_BYTES as JPEG
 *  (stepping quality down). Throws when the browser can't decode it. */
async function shrink(file: File): Promise<Shot> {
	const bitmap = await createImageBitmap(file);
	const { w, h } = fitWithin(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no canvas");
	ctx.fillStyle = "#fff"; // JPEG has no alpha
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	let blob: Blob | null = null;
	for (const quality of [0.85, 0.7, 0.55, 0.4]) {
		blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
		if (blob && blob.size <= SHOT_MAX_BYTES) break;
	}
	if (!blob || blob.size > SHOT_MAX_BYTES) throw new Error("too large");
	return { type: "image/jpeg", data: await blobToBase64(blob), preview: URL.createObjectURL(blob) };
}

export interface FeedbackBodyProps {
	/** Opened from an agent turn (shows the include checkbox). */
	fromMessage: boolean;
	kind: FeedbackKind;
	text: string;
	include: boolean;
	shots: readonly Pick<Shot, "preview">[];
	busy: boolean;
	error: string | null;
	sent: boolean;
	onKind: (k: FeedbackKind) => void;
	onText: (t: string) => void;
	onInclude: (v: boolean) => void;
	onAddShots: () => void;
	onRemoveShot: (i: number) => void;
	onSend: () => void;
	onClose: () => void;
}

const quiet = "rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground";

/** The dialog's pure body (SSR-pinnable, the delete-node pattern). */
export function FeedbackBody(p: FeedbackBodyProps) {
	const backdropDismiss = useBackdropDismiss(p.onClose);
	const title = p.fromMessage ? "Report a problem" : "Send feedback";
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={title}
			data-testid="feedback-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			{...backdropDismiss}
		>
			<div
				className="mx-4 flex max-h-[90dvh] w-full max-w-md flex-col overflow-y-auto rounded-xl border bg-card p-5 shadow-lg"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
				{p.sent ? (
					<>
						<p className="mt-1.5 text-xs text-muted-foreground" data-testid="feedback-sent">
							Thanks, sent.
						</p>
						<div className="mt-4 flex justify-end">
							<button type="button" className={quiet} onClick={p.onClose} data-testid="feedback-close">
								Close
							</button>
						</div>
					</>
				) : (
					<>
						<div className="mt-3 flex gap-1" role="radiogroup" aria-label="Kind">
							{(["bug", "idea"] as const).map((k) => (
								<button
									key={k}
									type="button"
									role="radio"
									aria-checked={p.kind === k}
									data-testid={`feedback-kind-${k}`}
									onClick={() => p.onKind(k)}
									className={`rounded-md border px-3 py-1 text-xs transition-colors ${
										p.kind === k ? "border-foreground/40 bg-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
									}`}
								>
									{k === "bug" ? "Bug" : "Idea"}
								</button>
							))}
						</div>
						<textarea
							data-testid="feedback-text"
							value={p.text}
							maxLength={FEEDBACK_TEXT_MAX}
							onChange={(e) => p.onText(e.target.value)}
							placeholder={p.kind === "bug" ? "What went wrong? What did you expect?" : "What would make this better?"}
							rows={5}
							// 16px on phones: iOS zooms into smaller inputs.
							className="mt-3 w-full resize-y rounded-md border bg-background p-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring sm:text-sm"
						/>
						<div className="mt-2 flex flex-wrap items-center gap-2">
							{p.shots.map((s, i) => (
								<div key={s.preview} className="relative">
									{/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
									<img src={s.preview} alt={`Screenshot ${i + 1}`} className="size-14 rounded border object-cover" />
									<button
										type="button"
										aria-label={`Remove screenshot ${i + 1}`}
										onClick={() => p.onRemoveShot(i)}
										className="absolute -right-1.5 -top-1.5 rounded-full border bg-card p-0.5 text-muted-foreground hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								</div>
							))}
							{p.shots.length < MAX_SCREENSHOTS && (
								<button type="button" onClick={p.onAddShots} className={`${quiet} flex items-center gap-1.5`} data-testid="feedback-add-shot">
									<ImagePlusIcon className="size-3.5" />
									Add screenshot
								</button>
							)}
						</div>
						{p.fromMessage && (
							<label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
								<input
									type="checkbox"
									checked={p.include}
									onChange={(e) => p.onInclude(e.target.checked)}
									data-testid="feedback-include"
									className="mt-0.5"
								/>
								<span>Include this conversation (the messages around this one and any errors in this chat)</span>
							</label>
						)}
						{p.error && (
							<p className="mt-2 text-xs text-destructive" role="alert" data-testid="feedback-error">
								{p.error}
							</p>
						)}
						<div className="mt-4 flex justify-end gap-2">
							<button type="button" className={quiet} onClick={p.onClose}>
								Cancel
							</button>
							<button
								type="button"
								data-testid="feedback-send"
								disabled={p.busy || !p.text.trim()}
								onClick={p.onSend}
								className="rounded-sm border border-foreground/30 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
							>
								{p.busy ? "Sending…" : "Send"}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

export function FeedbackDialog({
	open,
	onClose,
	chatId,
	messageId,
}: {
	open: boolean;
	onClose: () => void;
	chatId?: string;
	messageId?: string;
}) {
	const fromMessage = chatId !== undefined;
	const [kind, setKind] = useState<FeedbackKind>("bug");
	const [text, setText] = useState("");
	const [include, setInclude] = useState(true);
	const [shots, setShots] = useState<Shot[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	// Thumbnail object URLs are released when a shot is removed, when the
	// form resets, and on unmount.
	const shotsRef = useRef<Shot[]>([]);
	shotsRef.current = shots;
	useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.preview)), []);

	// Fresh form each time it opens.
	useEffect(() => {
		if (!open) return;
		shotsRef.current.forEach((s) => URL.revokeObjectURL(s.preview));
		setKind("bug");
		setText("");
		setInclude(true);
		setShots([]);
		setBusy(false);
		setError(null);
		setSent(false);
	}, [open, chatId, messageId]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Claimed at the document level (the one-Esc law, abort-turn-dialog).
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	const addFiles = useCallback(async (files: FileList | null) => {
		if (!files) return;
		setError(null);
		const room = MAX_SCREENSHOTS - shots.length;
		const picked = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, room);
		const added: Shot[] = [];
		for (const f of picked) {
			try {
				added.push(await shrink(f));
			} catch {
				setError(`Couldn't use ${f.name}. Try a PNG or JPEG screenshot.`);
			}
		}
		setShots((cur) => [...cur, ...added].slice(0, MAX_SCREENSHOTS));
	}, [shots.length]);

	const send = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/feedback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind,
					text,
					...(chatId ? { chatId, includeConversation: include } : {}),
					...(messageId ? { messageId } : {}),
					screenshots: shots.map(({ type, data }) => ({ type, data })),
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "Couldn't send. Please try again.");
				return;
			}
			setSent(true);
		} catch {
			setError("Couldn't send. Check your connection and try again.");
		} finally {
			setBusy(false);
		}
	}, [kind, text, chatId, messageId, include, shots]);

	if (!open || typeof document === "undefined") return null;
	return createPortal(
		<>
			<FeedbackBody
				fromMessage={fromMessage}
				kind={kind}
				text={text}
				include={include}
				shots={shots}
				busy={busy}
				error={error}
				sent={sent}
				onKind={setKind}
				onText={setText}
				onInclude={setInclude}
				onAddShots={() => fileInput.current?.click()}
				onRemoveShot={(i) =>
					setShots((cur) => {
						const gone = cur[i];
						if (gone) URL.revokeObjectURL(gone.preview);
						return cur.filter((_, j) => j !== i);
					})
				}
				onSend={() => void send()}
				onClose={onClose}
			/>
			<input
				ref={fileInput}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(e) => {
					void addFiles(e.target.files);
					e.target.value = "";
				}}
			/>
		</>,
		document.body,
	);
}
