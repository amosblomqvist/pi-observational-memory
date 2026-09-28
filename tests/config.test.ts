import { describe, expect, it } from "vitest";

import { normalizeObserverModel } from "../src/config.js";

describe("observer model config", () => {
	const primary = { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "low" as const };

	it("loads ordered fallback models with their own thinking level", () => {
		expect(
			normalizeObserverModel(
				{
					...primary,
					fallbackModels: [{ provider: "odevo", id: "openai/gpt-6-luna", thinking: "low" }],
				},
				primary,
			),
		).toEqual({
			...primary,
			fallbackModels: [{ provider: "odevo", id: "openai/gpt-6-luna", thinking: "low" }],
		});
	});

	it("ignores invalid and duplicate fallback entries", () => {
		expect(
			normalizeObserverModel(
				{
					...primary,
					fallbackModels: [
						{ provider: "openai-codex", id: "gpt-5.6-luna" },
						{ provider: "odevo", id: "openai/gpt-6-luna" },
						{ provider: "odevo" },
						null,
					],
				},
				primary,
			),
		).toEqual({ ...primary, fallbackModels: [{ provider: "odevo", id: "openai/gpt-6-luna" }] });
	});
});
