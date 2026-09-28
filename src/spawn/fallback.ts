import type { ConfiguredModel } from "../config.js";
import { isUsageLimitFailure, type WorkerExit } from "./launch.js";

export type ModelAttemptResult = {
	runId: string;
	exit: WorkerExit;
};

/** Retry in order only when an attempt failed with a provider usage/rate limit. */
export async function runWithUsageLimitFallback<T extends ModelAttemptResult>(
	models: ConfiguredModel[],
	runAttempt: (model: ConfiguredModel, index: number) => Promise<T>,
	onFallback?: (nextModel: ConfiguredModel) => void,
): Promise<{ model: ConfiguredModel; index: number; result: T }> {
	if (models.length === 0) throw new Error("observer fallback requires at least one model");
	for (let index = 0; index < models.length; index++) {
		const model = models[index];
		if (!model) break;
		const result = await runAttempt(model, index);
		if (result.exit.code === 0 || !isUsageLimitFailure(result.exit)) {
			return { model, index, result };
		}
		const nextModel = models[index + 1];
		if (!nextModel) return { model, index, result };
		onFallback?.(nextModel);
	}
	throw new Error("observer fallback requires at least one model");
}
