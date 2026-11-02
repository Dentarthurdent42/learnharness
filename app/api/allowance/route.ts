import { currentAllowance, economyActive, readAllowanceSettings, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** The signed-in user's allowance (cloud mode): faded spend, limit,
 *  level, and the economy switch's state — the sidebar meter and the
 *  chat notices read this. */
async function handleGET() {
	return Response.json({
		...currentAllowance(),
		economy: { available: Boolean(readAllowanceSettings().economy), active: economyActive() },
	});
}

export const GET = withUser(handleGET, { cloudOnly: true });
