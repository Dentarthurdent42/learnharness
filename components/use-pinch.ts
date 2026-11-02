"use client";
/**
 * Two-finger pinch zoom for the wheel-zoomed panes (iPhone wave, 2026-11):
 * the plan and session maps zoom on the mouse wheel, and iOS sends no
 * wheel for a pinch. This listens for two-touch moves on the element and
 * reports the step factor and the midpoint (element coordinates), the same
 * inputs zoomedGraphView takes from a wheel tick. While two fingers are
 * down, `pinching.current` is true so the one-finger pan can stand aside.
 */

import { useEffect, useRef, type RefObject } from "react";

export function usePinchZoom(
	ref: RefObject<HTMLElement | null>,
	onPinch: (factor: number, center: { x: number; y: number }) => void,
): RefObject<boolean> {
	const pinching = useRef(false);
	const cb = useRef(onPinch);
	cb.current = onPinch;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let last: number | null = null;
		const span = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
		const onStart = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				pinching.current = true;
				last = span(e.touches);
			}
		};
		const onMove = (e: TouchEvent) => {
			if (e.touches.length !== 2 || last === null) return;
			e.preventDefault();
			const now = span(e.touches);
			const rect = el.getBoundingClientRect();
			const center = {
				x: (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - rect.left,
				y: (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - rect.top,
			};
			if (last > 0 && now > 0) cb.current(now / last, center);
			last = now;
		};
		const onEnd = (e: TouchEvent) => {
			if (e.touches.length < 2) {
				last = null;
				if (e.touches.length === 0) pinching.current = false;
			}
		};
		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [ref]);
	return pinching;
}
