import { isPricedModel, readAllowanceSettings, withUser, writeAllowanceSettings, type AllowanceSettings } from "@/src/server";

export const dynamic = "force-dynamic";

/** The admin page's allowance settings: default limit, fade speed, and the
 *  economy preset. */
async function handleGET() {
	return Response.json(readAllowanceSettings());
}

async function handlePUT(req: Request) {
	const body = (await req.json().catch(() => null)) as Partial<AllowanceSettings> | null;
	if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	const current = readAllowanceSettings();
	const limitUsd = body.limitUsd ?? current.limitUsd;
	const halfLifeHours = body.halfLifeHours ?? current.halfLifeHours;
	if (!(typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0)) {
		return Response.json({ error: "The limit must be a dollar amount of 0 or more." }, { status: 400 });
	}
	if (!(typeof halfLifeHours === "number" && Number.isFinite(halfLifeHours) && halfLifeHours > 0)) {
		return Response.json({ error: "The fade time must be more than 0 hours." }, { status: 400 });
	}
	// economy: absent = keep, null = clear, object = set (must be priced —
	// an unpriced preset would make economy turns count as $0).
	let economy = current.economy;
	if (body.economy === null) economy = undefined;
	else if (body.economy !== undefined) {
		const m = body.economy.model;
		if (!m || typeof m.provider !== "string" || typeof m.id !== "string") {
			return Response.json({ error: "The economy preset needs a model." }, { status: 400 });
		}
		if (!isPricedModel(m.provider, m.id)) {
			return Response.json({ error: "Pick a model with a known price for the economy preset." }, { status: 400 });
		}
		economy = { model: { provider: m.provider, id: m.id }, ...(body.economy.thinkingLevel ? { thinkingLevel: body.economy.thinkingLevel } : {}) };
	}
	return Response.json(writeAllowanceSettings({ limitUsd, halfLifeHours, ...(economy ? { economy } : {}) }));
}

export const GET = withUser(handleGET, { admin: true, cloudOnly: true });
export const PUT = withUser(handlePUT, { admin: true, cloudOnly: true });
