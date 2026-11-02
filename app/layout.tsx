import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AccountModeProvider, SignedOutWatcher } from "@/components/account";
import { CLOUD_MODE } from "@/tenancy";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// iPhone wave (2026-11): Add to Home Screen opens full screen with the
	// app's icon; the status bar floats over the dark page.
	appleWebApp: { capable: true, title: "LearnHarness", statusBarStyle: "black-translucent" },
	icons: { apple: "/icons/apple-touch-icon.png" },
};

/** viewport-fit=cover lets the page reach under the notch and home bar;
 *  the chrome pads itself with env(safe-area-inset-*) where it touches an
 *  edge. */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: "#141414",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The app chrome (providers, sidebar, update banner) lives in
			    app/(main)/layout.tsx; the cloud sign-in pages in app/(auth)
			    render bare — no shell, no event channel to a signed-out API. */}
			<SignedOutWatcher />
			<AccountModeProvider cloud={CLOUD_MODE}>{children}</AccountModeProvider>
		</body>
		</html>
	);
}
