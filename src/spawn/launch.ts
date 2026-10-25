/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as piPackage from "@earendil-works/pi-coding-agent";
import type { ConfiguredModel } from "../config.js";
import { runCostPath, runResultPath } from "./runs.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

export function modelArg(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

type PiBinary = { command: string; baseArgs: string[]; shell?: boolean };

/** The host's own pi package dir: `getPackageDir()` when this pi version exports it, else walk up from the resolved entry. */
function findPiPackageDir(): string | undefined {
	try {
		const getDir = (piPackage as { getPackageDir?: () => string }).getPackageDir;
		if (typeof getDir === "function") return getDir();
	} catch {
		// fall through
	}
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (;;) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath) && JSON.parse(readFileSync(pkgPath, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
			const parent = dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	} catch {
		return undefined;
	}
}

/**
 * Resolve the `pi` CLI: the host's own pi package `bin` first (works under any host that embeds pi
 * via the SDK, e.g. a Next.js server whose argv[1] is not pi), then `pi` on PATH. On Windows `pi` is
 * `pi.cmd`, which spawn can only run through a shell; safe there because the prompt now goes via
 * stdin, so argv holds only fixed flags and model/session names.
 */
export function resolvePiBinary(): PiBinary {
	const dir = findPiPackageDir();
	if (dir) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
			if (bin) {
				const cli = resolve(dir, bin);
				if (existsSync(cli)) return { command: process.execPath, baseArgs: [realpathSync(cli)] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [], shell: process.platform === "win32" };
}

export type WorkerLaunch = { argv: string[]; stdin: string; shell: boolean };

/** The prompt travels on the child's stdin (pi uses piped stdin as the initial message under `-p`): a ~10k-token chunk in argv exceeds the Windows command-line limit. */
export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	kickoffPrompt: string;
	agentExtensionPath?: string;
}): WorkerLaunch {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	args.push("-p");
	return { argv: [pi.command, ...args], stdin: opts.kickoffPrompt, shell: pi.shell ?? false };
}

export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/**
 * Spawn a headless worker; resolve when it exits. Workers run in their master session's
 * `.memory/<sessionId>/` root (not the project cwd) so pi keys the run into a distinct global
 * session bucket and it never clutters the project's `/resume` picker. The root is ensured to
 * exist before spawn — `spawn()` would ENOENT otherwise (the memory root is created lazily on
 * first durable write when there is no parent to seed).
 */
export function spawnWorker(opts: {
	argv: string[];
	/** Prompt written to the child's stdin. */
	stdin: string;
	shell?: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}): Promise<WorkerExit> {
	const [command, ...rest] = opts.argv;
	mkdirSync(opts.cwd, { recursive: true });
	return new Promise<WorkerExit>((resolvePromise) => {
		let proc: ChildProcess;
		try {
			proc = spawn(command, rest, {
				cwd: opts.cwd,
				env: opts.env,
				shell: opts.shell,
				stdio: ["pipe", "ignore", "pipe"],
			});
		} catch (err) {
			resolvePromise({ code: 1, signal: null, stderr: `spawn error: ${(err as Error).message}` });
			return;
		}
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.stdin?.on("error", () => {
			// EPIPE: the child exited before reading its prompt; the close/error handlers report it.
		});
		proc.stdin?.end(opts.stdin);
		proc.on("error", (err) => resolvePromise({ code: 1, signal: null, stderr: stderr || `spawn error: ${err.message}` }));
		proc.on("close", (code, signal) => resolvePromise({ code, signal, stderr }));

		if (opts.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000).unref?.();
			};
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
	});
}

export type ObserverLaunchEnv = {
	/** Absolute `.memory/<sessionId>/` root — IPC files and the consolidator sandbox live here. */
	memoryRoot: string;
	runId: string;
};

/**
 * Build the env a worker subprocess needs to write its result file. The chunk itself is NOT
 * passed via env/file — it is the worker's stdin prompt (recorded user message) so the run stays
 * faithfully inspectable on resume.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: ObserverLaunchEnv): NodeJS.ProcessEnv {
	return {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		OM_RESULT_PATH: runResultPath(opts.memoryRoot, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.memoryRoot, opts.runId),
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		OM_MEMORY_DIR: opts.memoryRoot,
	};
}
