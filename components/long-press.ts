"use client";
/**
 * Long-press for touch (iPhone wave, 2026-11, owner design): the phone's
 * stand-in for right-click. iOS Safari never fires contextmenu, so menus
 * that open on right-click also open on a ~500ms press-and-hold. Mouse
 * and pen are untouched (right-click stays their path). Moving more than
 * a few pixels cancels (that is a scroll or a pan), and the click that
 * ends a long-press is swallowed so the row doesn't also navigate.
 */

import { useCallback, useRef } from "react";

export const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;

export function useLongPress<T extends HTMLElement>(onLongPress: (target: T, pos: { x: number; y: number }) => void) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const origin = useRef<{ x: number; y: number } | null>(null);
	const fired = useRef(false);

	const cancel = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		origin.current = null;
	}, []);

	return {
		onPointerDown: (e: React.PointerEvent<T>) => {
			fired.current = false;
			if (e.pointerType !== "touch") return;
			const target = e.currentTarget;
			const pos = { x: e.clientX, y: e.clientY };
			origin.current = pos;
			timer.current = setTimeout(() => {
				timer.current = null;
				fired.current = true;
				onLongPress(target, pos);
			}, LONG_PRESS_MS);
		},
		onPointerMove: (e: React.PointerEvent<T>) => {
			if (!origin.current) return;
			if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > MOVE_SLOP) cancel();
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		onClickCapture: (e: React.MouseEvent<T>) => {
			if (!fired.current) return;
			fired.current = false;
			e.preventDefault();
			e.stopPropagation();
		},
	};
}
