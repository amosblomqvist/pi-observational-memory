import { describe, expect, it, vi } from "vitest";

import { runWithUsageLimitFallback } from "../src/spawn/fallback.js";

const primary = { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "low" as const };
const backup = { provider: "odevo", id: "openai/gpt-6-luna", thinking: "low" as const };

describe("observer model fallback", () => {
	it("tries the configured backup after a provider usage limit", async () => {
		const runAttempt = vi
			.fn()
			.mockResolvedValueOnce({ runId: "observer", exit: { code: 1, signal: null, stderr: "Codex error: The usage limit has been reached" } })
			.mockResolvedValueOnce({ runId: "observer-fallback-1", exit: { code: 0, signal: null, stderr: "" } });
		const onFallback = vi.fn();

		const result = await runWithUsageLimitFallback([primary, backup], runAttempt, onFallback);

		expect(runAttempt).toHaveBeenNthCalledWith(1, primary, 0);
		expect(runAttempt).toHaveBeenNthCalledWith(2, backup, 1);
		expect(onFallback).toHaveBeenCalledWith(backup);
		expect(result).toEqual({ model: backup, index: 1, result: { runId: "observer-fallback-1", exit: { code: 0, signal: null, stderr: "" } } });
	});

	it("does not retry non-quota failures", async () => {
		const runAttempt = vi.fn().mockResolvedValue({
			runId: "observer",
			exit: { code: 1, signal: null, stderr: "API key is invalid" },
		});
		const onFallback = vi.fn();

		const result = await runWithUsageLimitFallback([primary, backup], runAttempt, onFallback);

		expect(runAttempt).toHaveBeenCalledTimes(1);
		expect(onFallback).not.toHaveBeenCalled();
		expect(result.model).toBe(primary);
	});
});
