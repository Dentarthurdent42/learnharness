"use client";

import { useCallback, useRef, useState } from "react";

/*
 * Edge open + drawer drag (owner, 2026-11-13).
 *
 * - A 12px invisible strip on the window's left edge while the sidebar is
 *   closed: a tap/click opens it (desktop hover shows a faint highlight
 *   and a pointer cursor). It sits exactly over the headers' px-3 gutter.
 * - Phone: a rightward swipe that STARTS on that strip drags the drawer
 *   out under the finger; a leftward swipe on the open drawer (or its
 *   backdrop) drags it back. Release snaps by distance or flick speed.
 * - Wider than phone: the inline sidebar animates width, so it does not
 *   track the finger — a swipe right from the strip just opens it.
 */

/** Fraction of the drawer width a drag must pass to commit. */
const COMMIT_FRACTION = 0.35;
/** Flick speed (px/ms) that commits regardless of distance. */
const FLICK_SPEED = 0.4;
/** Movement (px) below which a press counts as a tap. */
const TAP_SLOP = 8;

type Drag = {
	pointerId: number;
	startX: number;
	startY: number;
	width: number;
	/** Engaged = the gesture is ours (horizontal); before that it may be a tap or a vertical scroll. */
	engaged: boolean;
	lastX: number;
	lastT: number;
	velocity: number;
};

function track(d: Drag, e: React.PointerEvent) {
	const dt = e.timeStamp - d.lastT;
	if (dt > 0) d.velocity = (e.clientX - d.lastX) / dt;
	d.lastX = e.clientX;
	d.lastT = e.timeStamp;
}

function begin(e: React.PointerEvent, width: number, engaged: boolean): Drag {
	return {
		pointerId: e.pointerId,
		startX: e.clientX,
		startY: e.clientY,
		width,
		engaged,
		lastX: e.clientX,
		lastT: e.timeStamp,
		velocity: 0,
	};
}

/**
 * Drag state for the phone drawer. `offset` is the drawer's live
 * translate in px (−width … 0) while a drag is in flight, null at rest —
 * the aside renders it inline with transitions off, and dropping it back
 * to null lets the class transition finish the snap from wherever the
 * finger let go.
 */
export function useDrawerDrag({
	open,
	phone,
	measure,
	onOpen,
	onClose,
}: {
	open: boolean;
	phone: boolean;
	/** The drawer's current width in px (read at gesture start). */
	measure: () => number;
	onOpen: () => void;
	onClose: () => void;
}) {
	const [live, setLive] = useState<{ x: number; width: number } | null>(null);
	const drag = useRef<Drag | null>(null);
	/** Set after an engaged close-drag so the release doesn't click a row. */
	const swallowClick = useRef(false);
	/** Same for the edge strip: a drag release must not also count as a tap. */
	const edgeSwallowClick = useRef(false);

	const end = useCallback(() => {
		drag.current = null;
		setLive(null);
	}, []);

	/* ── Edge strip (closed state) ─────────────────────────────────── */

	const edgeHandlers = {
		onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.currentTarget.setPointerCapture(e.pointerId);
			drag.current = begin(e, measure() || 288, false);
		},
		onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
			const d = drag.current;
			if (!d || d.pointerId !== e.pointerId) return;
			track(d, e);
			const dx = e.clientX - d.startX;
			if (!d.engaged && Math.abs(dx) > TAP_SLOP) d.engaged = true;
			if (d.engaged && phone) setLive({ x: Math.min(0, Math.max(-d.width, -d.width + dx)), width: d.width });
		},
		onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
			const d = drag.current;
			if (!d || d.pointerId !== e.pointerId) return;
			const dx = e.clientX - d.startX;
			const engaged = d.engaged;
			end();
			// A tap opens on the click instead — opening here would mount the
			// backdrop under the finger and the tap's own click would land
			// on it and close the drawer again.
			if (!engaged) return;
			edgeSwallowClick.current = true;
			setTimeout(() => (edgeSwallowClick.current = false), 0);
			const commit = phone
				? dx > d.width * COMMIT_FRACTION || d.velocity > FLICK_SPEED
				: dx > 0; // wide: any rightward swipe opens
			if (commit) onOpen();
		},
		onPointerCancel: () => end(),
		onClick: () => {
			if (edgeSwallowClick.current) {
				edgeSwallowClick.current = false;
				return;
			}
			onOpen();
		},
	};

	/* ── Open drawer / backdrop (phone, touch & pen only) ──────────── */

	const drawerHandlers = {
		onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
			if (!phone || !open || e.pointerType === "mouse") return;
			drag.current = begin(e, measure() || 288, false);
		},
		onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			if (!d || d.pointerId !== e.pointerId) return;
			track(d, e);
			const dx = e.clientX - d.startX;
			const dy = e.clientY - d.startY;
			if (!d.engaged) {
				if (Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return;
				// Direction lock: vertical (list scroll) or rightward isn't ours.
				if (Math.abs(dy) >= Math.abs(dx) || dx > 0) {
					drag.current = null;
					return;
				}
				d.engaged = true;
				e.currentTarget.setPointerCapture(e.pointerId);
			}
			setLive({ x: Math.min(0, Math.max(-d.width, dx)), width: d.width });
		},
		onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			if (!d || d.pointerId !== e.pointerId) return;
			const dx = e.clientX - d.startX;
			const engaged = d.engaged;
			end();
			if (!engaged) return;
			swallowClick.current = true;
			setTimeout(() => (swallowClick.current = false), 0);
			if (-dx > d.width * COMMIT_FRACTION || d.velocity < -FLICK_SPEED) onClose();
		},
		onPointerCancel: () => end(),
		onClickCapture: (e: React.MouseEvent) => {
			if (!swallowClick.current) return;
			swallowClick.current = false;
			e.preventDefault();
			e.stopPropagation();
		},
	};

	return {
		/** Live x translate (px) while dragging, else null. */
		offset: live?.x ?? null,
		/** 0 (closed) … 1 (open) while dragging — drives the backdrop. */
		progress: live ? 1 + live.x / live.width : null,
		edgeHandlers,
		drawerHandlers,
	};
}

/** The invisible left-edge strip — rendered only while the sidebar is closed. */
export function SidebarEdge(props: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			aria-hidden
			data-testid="sidebar-edge"
			className="lh-no-drag fixed inset-y-0 left-0 z-30 w-3 cursor-pointer touch-none transition-colors duration-150 hover:bg-foreground/5"
			{...props}
		/>
	);
}
