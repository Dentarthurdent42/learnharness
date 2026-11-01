import { modelCatalog, withUser } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version.
 */
async function handleGET() {
	return Response.json(modelCatalog());
}

// Cloud mode: signed-in users only, run in their data scope (src/server/auth.ts).
export const GET = withUser(handleGET);
