import type { MetadataRoute } from "next";

/** Home Screen install (iPhone wave, 2026-11): standalone, the app's own
 *  dark background, the flat icon (build/icon-flat.svg, rendered into
 *  public/icons/). */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
		],
	};
}
