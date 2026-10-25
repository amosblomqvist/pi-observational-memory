import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

const body = "x".repeat(40);

function setup(memoryRoot: string) {
	let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
	const fakePi = { on: (name: string, fn: any) => name === "session_before_compact" && (handler = fn) } as any;
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.configLoaded = true; // keep the user's real settings (and debug log) out of the test
	runtime.memoryRoot = memoryRoot;
	registerCompactionHook(fakePi, runtime);
	const notes: string[] = [];
	const ctxFor = (branch: any[]) => ({
		hasUI: true,
		cwd: memoryRoot,
		ui: { notify: (m: string) => notes.push(m) },
		sessionManager: { getBranch: () => branch },
	});
	return { handler: handler!, ctxFor, notes };
}

describe("session_before_compact empty-summary fallback", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-fallback-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined (pi's built-in compaction) when there is no memory to render", async () => {
		const { handler, ctxFor, notes } = setup(dir);
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body), rawMessage("raw-3", body)];
		const result = await handler({ preparation: { firstKeptEntryId: "raw-3", tokensBefore: 30 }, branchEntries: branch }, ctxFor(branch));
		expect(result).toBeUndefined();
		expect(notes.some((n) => n.includes("built-in compaction"))).toBe(true);
	});

	it("still provides the rendered compaction when observations exist", async () => {
		const { handler, ctxFor } = setup(dir);
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
		];
		const result = await handler({ preparation: { firstKeptEntryId: "raw-3", tokensBefore: 30 }, branchEntries: branch }, ctxFor(branch));
		expect(result?.compaction?.firstKeptEntryId).toBe("raw-3");
		expect(result.compaction.summary).toContain("## Observations");
	});
});
