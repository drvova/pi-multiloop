import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createChildAgentSession,
	extractLastAssistantText,
	promptChildAgent,
} from "../../../child-agent/src/index.js";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import multiloopExtension, {
	buildAutoContinuePrompt,
	collectRunningLoops,
} from "../../../multiloop/extensions/pi-multiloop/index.js";

const CHILD_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const MULTILOOP_TOOLS = [
	"multiloop_start",
	"multiloop_iterate",
	"multiloop_measure",
	"multiloop_decide",
	"multiloop_log",
	"multiloop_resume",
	"multiloop_pause",
	"multiloop_stop",
	"multiloop_archive",
	"multiloop_compare",
] as const;

const LOOP_MODES = ["optimize", "punchlist", "research", "dev"] as const;
type LoopAgentMode = (typeof LOOP_MODES)[number];

const LOOP_AGENT_SYSTEM_PROMPT = `You are the Loop Runner: an autonomous pi-multiloop subagent. You run one bounded experiment loop in the caller's repository and report the outcome. Your final message is the report and the only thing the caller sees.

You have the pi-multiloop tools (multiloop_start, multiloop_iterate, multiloop_measure, multiloop_decide, multiloop_log, multiloop_resume, multiloop_pause, multiloop_stop, multiloop_archive, multiloop_compare) plus the full local tool set (read, bash, edit, write, grep, find, ls). Loop state persists under .multiloop/ in the working directory and is shared with the parent session.

Cadence:
1. Call multiloop_start exactly once with the launch config from the user message, passing the exact runTag you were given and every stop condition (maxIterations, targetMetric). An unrecorded bound does not exist.
2. Repeat while the loop is running: multiloop_iterate (state the hypothesis first), make one focused change inside scope with your tools, run the verify command and any guard command, then persist the measurements and every configured mechanical/prompt check verdict with multiloop_measure, and close the iteration with multiloop_decide (keep/revert loops) or multiloop_log (log-mode loops). A bash verify output alone is not recorded until multiloop_measure persists it.
3. Never fabricate a measurement: only numbers a command actually printed may go to multiloop_measure. If a configured guard or prompt verifier is omitted from a measurement it counts as failed.
4. Stay inside the configured scope and never modify protected paths. One small reversible change per iteration; no rewrites.
5. If the same approach stalls across iterations, pivot to a materially different one. If you cannot proceed safely, call multiloop_stop with the reason instead of thrashing.
6. Drive only your own loop. Other loops may be visible in .multiloop state; never call loop tools for a lane/runTag that is not yours.
7. When your loop reaches a terminal state (completed, stopped, or paused on a hard blocker), stop calling loop tools and write the report.

Report format (markdown, self-contained):

# Loop report: <lane>/<runTag>

## Outcome

Final status, iterations completed, best metric, keep/revert tally.

## Iterations

One line per iteration: hypothesis, change, metric, decision.

## Verification

Final verify and guard results.

## Remaining

Anything unfinished, or the recommended next run.`;

interface LoopAgentRequest {
	goal: string;
	verifyCommand: string;
	lane?: string;
	mode?: LoopAgentMode;
	metricDirection?: "lower" | "higher";
	guardCommand?: string;
	promptVerifier?: string;
	scope?: string;
	protectedPaths?: string[];
	maxIterations?: number;
	targetMetric?: number;
	resume?: string;
}

/** Live progress snapshot streamed to the parent via onUpdate partials and the fleet widget. */
interface LoopProgress {
	turns: number;
	toolUses: number;
	iteration: number;
	lastMetric?: number;
	lastDecision?: string;
	activity: string;
	elapsedMs: number;
}

interface LoopAgentDetails {
	lane: string;
	runTag: string;
	progress: LoopProgress;
	status: RunStatus;
	report?: string;
}

type RunStatus = "running" | "finished" | "failed" | "stopped";

interface RunRecord {
	lane: string;
	runTag: string;
	goal: string;
	status: RunStatus;
	startedAt: number;
	settledAt?: number;
	progress: LoopProgress;
	report?: string;
	error?: string;
	stopRequested?: boolean;
	settled?: Promise<void>;
	session?: {
		prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
		abort(): Promise<void>;
		dispose(): void;
	};
}

const WIDGET_KEY = "multiloop-agents";
const ACTIVITY_LIMIT = 60;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function summarizeToolCall(toolName: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return `bash: ${truncate(String(record.command ?? ""), ACTIVITY_LIMIT)}`;
		case "read":
		case "edit":
		case "write":
			return `${toolName}: ${String(record.path ?? record.file_path ?? "")}`;
		case "grep":
		case "find":
			return `${toolName}: ${String(record.pattern ?? "")}`;
		case "ls":
			return `ls: ${String(record.path ?? ".")}`;
		default:
			return toolName.startsWith("multiloop_") ? toolName.replace("multiloop_", "loop ") : toolName || "working";
	}
}

function formatProgressLine(details: LoopAgentDetails): string {
	const progress = details.progress;
	const spinner = SPINNER[progress.turns % SPINNER.length];
	const parts = [`${spinner} loop agent ${details.lane}`, `turn ${progress.turns}`, `${progress.toolUses} tools`];
	if (progress.iteration > 0) parts.push(`iteration ${progress.iteration}`);
	if (progress.lastMetric !== undefined) parts.push(`metric ${progress.lastMetric}`);
	if (progress.lastDecision) parts.push(`last: ${progress.lastDecision}`);
	parts.push(`${Math.round(progress.elapsedMs / 1000)}s`);
	return parts.join(" · ");
}

function initialProgress(): LoopProgress {
	return { turns: 0, toolUses: 0, iteration: 0, activity: "starting", elapsedMs: 0 };
}

function validateLoopAgentArgs(request: LoopAgentRequest): LoopAgentRequest {
	if (!request.resume?.trim()) {
		if (!request.goal?.trim()) throw new Error("multiloop_agent requires a non-empty `goal`.");
		if (!request.verifyCommand?.trim()) throw new Error("multiloop_agent requires a non-empty `verifyCommand`.");
	}
	if (request.maxIterations !== undefined && (!Number.isInteger(request.maxIterations) || request.maxIterations < 1)) {
		throw new Error("multiloop_agent `maxIterations` must be a positive integer.");
	}
	return { ...request, goal: request.goal?.trim() ?? "", verifyCommand: request.verifyCommand?.trim() ?? "" };
}

function buildSystemPrompt(cwd: string): string {
	const agentsPath = resolve(cwd, "AGENTS.md");
	if (!existsSync(agentsPath)) return LOOP_AGENT_SYSTEM_PROMPT;
	return `${LOOP_AGENT_SYSTEM_PROMPT}\n\n## Repository instructions (AGENTS.md)\n\n${readFileSync(agentsPath, "utf8")}`;
}

function buildLaunchPrompt(request: LoopAgentRequest, lane: string, runTag: string, cwd: string): string {
	const lines = [
		`Run an autonomous pi-multiloop in ${cwd} with this approved launch config:`,
		"",
		`- goal: ${request.goal}`,
		`- lane: ${lane}`,
		`- runTag: ${runTag} — pass exactly this to multiloop_start`,
		`- mode: ${request.mode ?? "optimize"}`,
		`- verifyCommand: \`${request.verifyCommand}\``,
	];
	if (request.metricDirection) lines.push(`- metricDirection: ${request.metricDirection}`);
	if (request.guardCommand) lines.push(`- guardCommand: \`${request.guardCommand}\``);
	if (request.promptVerifier) lines.push(`- promptVerifier: ${request.promptVerifier}`);
	if (request.scope) lines.push(`- scope: ${request.scope}`);
	if (request.protectedPaths?.length) lines.push(`- protectedPaths: ${request.protectedPaths.join(", ")}`);
	if (request.maxIterations !== undefined) lines.push(`- maxIterations: ${request.maxIterations}`);
	if (request.targetMetric !== undefined) lines.push(`- targetMetric: ${request.targetMetric}`);
	lines.push(
		"",
		"The config above is the approval: call multiloop_start immediately, then drive the iterate/measure/decide cadence until the loop reaches a terminal state. Do not ask questions; there is no user to answer them.",
	);
	return lines.join("\n");
}

function buildResumePrompt(resumeTarget: string, cwd: string): string {
	return [
		`Resume the existing pi-multiloop run "${resumeTarget}" in ${cwd}.`,
		"",
		`Call multiloop_resume with target "${resumeTarget}", then drive the iterate/measure/decide cadence from your instructions until the loop reaches a terminal state. Do not call multiloop_start — the loop already exists. Do not ask questions; there is no user to answer them.`,
	].join("\n");
}

// ponytail: the nudge cap only bounds turn-end recovery; the loop's own
// maxIterations/targetMetric bounds the real work. Raise if loops legitimately
// end their turn more than this often mid-run.
const DRIVER_NUDGE_LIMIT = 25;

// ponytail: terminal records are retained so multiloop_agent_result can serve
// reports after completion; bounded at 10, oldest evicted first.
const FINISHED_KEEP = 10;

function pruneFinished(runs: Map<string, RunRecord>): void {
	const terminal = [...runs.entries()].filter(([, record]) => record.status !== "running");
	if (terminal.length <= FINISHED_KEEP) return;
	terminal.sort((a, b) => a[1].startedAt - b[1].startedAt);
	for (const [key] of terminal.slice(0, terminal.length - FINISHED_KEEP)) runs.delete(key);
}

async function runLoopAgent(
	record: RunRecord,
	firstPrompt: string,
	model: Model<any>,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: LoopAgentDetails }) => void) | undefined,
	ctx: ExtensionContext,
	onProgress: () => void,
): Promise<{ report: string; progress: LoopProgress }> {
	// Isolated child session via the shared child-agent core: the frozen
	// pi-multiloop extension is the only extension, the Loop Runner prompt is
	// the only system prompt, and the caller's model is inherited unchanged.
	const session = await createChildAgentSession({
		cwd,
		model,
		systemPrompt: buildSystemPrompt(cwd),
		tools: [...CHILD_BUILTIN_TOOLS, ...MULTILOOP_TOOLS],
		extensionFactories: [multiloopExtension],
	});
	record.session = session;
	const snapshot = (): LoopAgentDetails => ({
		lane: record.lane,
		runTag: record.runTag,
		progress: { ...record.progress, elapsedMs: Date.now() - record.startedAt },
		status: record.status,
	});
	const emit = (): void => {
		const details = snapshot();
		onUpdate?.({
			content: [{ type: "text", text: `${formatProgressLine(details)}\n⎿ ${record.progress.activity}` }],
			details,
		});
		onProgress();
	};
	const unsubscribe = session.subscribe((event) => {
		const e = event as { type: string; toolName?: string; args?: unknown; isError?: boolean };
		const progress = record.progress;
		if (e.type === "turn_start") {
			progress.turns += 1;
		} else if (e.type === "tool_execution_start") {
			progress.toolUses += 1;
			const name = e.toolName ?? "";
			progress.activity = summarizeToolCall(name, e.args);
			if (name === "multiloop_iterate") progress.iteration += 1;
			else if (name === "multiloop_measure") {
				const first = (e.args as { measurements?: unknown[] } | undefined)?.measurements?.[0];
				if (typeof first === "number") progress.lastMetric = first;
			} else if (name === "multiloop_decide") {
				const action = (e.args as { action?: unknown } | undefined)?.action;
				if (typeof action === "string") progress.lastDecision = action;
			} else if (name === "multiloop_log") {
				progress.lastDecision = "log";
			}
		} else if (e.type === "tool_execution_end" && (e.toolName ?? "").startsWith("multiloop_")) {
			// The disk state is authoritative for the iteration counter: a loop
			// tool call against a terminal loop is refused and must not inflate
			// the display. Refresh from the registry after each loop tool call.
			const onDisk = collectRunningLoops(cwd, new Set()).find((state) => state.runTag === record.runTag);
			if (onDisk) progress.iteration = onDisk.iteration;
			if (e.isError) progress.activity = `${e.toolName ?? "tool"} failed`;
		} else if (e.type === "tool_execution_end" && e.isError) {
			progress.activity = `${e.toolName ?? "tool"} failed`;
		} else {
			return;
		}
		emit();
	});
	try {
		emit();
		await promptChildAgent(session, firstPrompt, signal, () => new Error("multiloop_agent run aborted"));
		// The frozen extension re-prompts the child via followUp messages, but a
		// turn can still end with the loop running (provider hiccup, long turn).
		// Re-nudge from the durable on-disk state until the run leaves the
		// active registry.
		for (let nudge = 0; nudge < DRIVER_NUDGE_LIMIT; nudge++) {
			const mine = collectRunningLoops(cwd, new Set()).filter((state) => state.runTag === record.runTag);
			if (mine.length === 0) break;
			await session.prompt(buildAutoContinuePrompt(cwd, mine));
		}
	} finally {
		unsubscribe();
		record.session = undefined;
		await session.dispose();
	}
	return {
		report: extractLastAssistantText(session, "# Loop report\n\n## Outcome\n\nThe loop subagent finished without producing a report."),
		progress: snapshot().progress,
	};
}

// Fleet widget adapted from @tintinweb/pi-subagents (MIT, (c) 2026 tintinweb):
// tree layout, register-once factory with requestRender updates, and a
// timer-driven spinner. The data model is loop runs, not generic agents.
const FLEET_TICK_MS = 100;
const MAX_WIDGET_LINES = 12;
const FINISHED_LINGER_MS = 8_000;
const ERROR_LINGER_MS = 15_000;

type WidgetTheme = { fg(color: string, text: string): string; bold(text: string): string };

function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncateLine(text: string, limit = 40): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

class LoopFleetWidget {
	private uiCtx?: ExtensionContext;
	private tui?: { requestRender(): void };
	private interval?: ReturnType<typeof setInterval>;
	private registered = false;
	private frame = 0;

	constructor(private readonly runs: Map<string, RunRecord>) {}

	setContext(ctx: ExtensionContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/** Visible records: running, plus terminal ones inside their linger window. */
	private visible(): RunRecord[] {
		const now = Date.now();
		return [...this.runs.values()].filter(
			(record) =>
				record.status === "running" ||
				(record.settledAt !== undefined &&
					now - record.settledAt < (record.status === "finished" ? FINISHED_LINGER_MS : ERROR_LINGER_MS)),
		);
	}

	private ensureTimer(): void {
		if (!this.interval) {
			this.interval = setInterval(() => this.update(), FLEET_TICK_MS);
			this.interval.unref?.();
		}
	}

	update(): void {
		const ctx = this.uiCtx;
		if (!ctx?.hasUI) return;
		if (this.visible().length === 0) {
			if (this.registered) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			if (this.interval) {
				clearInterval(this.interval);
				this.interval = undefined;
			}
			return;
		}
		this.ensureTimer();
		this.frame += 1;
		if (!this.registered) {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: () => this.render(tui, theme),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private render(tui: { terminal: { columns: number } }, theme: WidgetTheme): string[] {
		const visible = this.visible();
		const running = visible.filter((record) => record.status === "running");
		const terminal = visible.filter((record) => record.status !== "running");
		if (running.length === 0 && terminal.length === 0) return [];
		const headingColor = running.length > 0 ? "accent" : "dim";
		const heading = theme.fg(headingColor, running.length > 0 ? "●" : "○") + " " + theme.fg(headingColor, "Loop agents");
		const body: string[] = [];
		for (const record of terminal) body.push(this.renderTerminalLine(record, theme));
		for (const record of running) body.push(...this.renderRunningLines(record, theme));
		const maxBody = MAX_WIDGET_LINES - 1;
		if (body.length > maxBody) {
			const shown = body.slice(0, maxBody - 1);
			shown.push(theme.fg("dim", `└─ +${body.length - shown.length} more`));
			return [heading, ...shown].map((line) => truncateToWidth(line, tui.terminal.columns));
		}
		if (body.length > 0) {
			const last = body.length - 1;
			if (body[last].includes("│  ")) {
				body[last] = body[last].replace("│  ", "   ");
				const above = body[last - 1];
				if (above?.includes("├─")) body[last - 1] = above.replace("├─", "└─");
			} else {
				body[last] = body[last].replace("├─", "└─");
			}
		}
		return [heading, ...body].map((line) => truncateToWidth(line, tui.terminal.columns));
	}

	private renderRunningLines(record: RunRecord, theme: WidgetTheme): string[] {
		const progress = record.progress;
		const frame = SPINNER[this.frame % SPINNER.length];
		const stats = [`↻${progress.turns}`];
		if (progress.toolUses > 0) stats.push(`${progress.toolUses} tool use${progress.toolUses === 1 ? "" : "s"}`);
		if (progress.iteration > 0) stats.push(`iteration ${progress.iteration}`);
		if (progress.lastMetric !== undefined) stats.push(`metric ${progress.lastMetric}`);
		if (progress.lastDecision) stats.push(`last: ${progress.lastDecision}`);
		stats.push(formatMs(Date.now() - record.startedAt));
		const header =
			theme.fg("dim", "├─") +
			` ${theme.fg("accent", frame)} ${theme.bold(`loop:${record.lane}`)}  ${theme.fg("muted", truncateLine(record.goal))} ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}`;
		const activity = theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${truncateLine(progress.activity, 60)}`);
		return [header, activity];
	}

	private renderTerminalLine(record: RunRecord, theme: WidgetTheme): string {
		const progress = record.progress;
		const icon =
			record.status === "finished"
				? theme.fg("success", "✓")
				: record.status === "stopped"
					? theme.fg("dim", "■")
					: theme.fg("error", "✗");
		const parts = [`↻${progress.turns}`, `${progress.toolUses} tool uses`, `${progress.iteration} iterations`, formatMs((record.settledAt ?? Date.now()) - record.startedAt)];
		const suffix =
			record.status === "failed"
				? theme.fg("error", ` error: ${(record.error ?? "").slice(0, 60)}`)
				: record.status === "stopped"
					? theme.fg("dim", " stopped")
					: "";
		return theme.fg("dim", "├─") + ` ${icon} ${theme.fg("dim", `loop:${record.lane}`)}  ${theme.fg("dim", truncateLine(record.goal))} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${suffix}`;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		if (this.registered && this.uiCtx) {
			this.uiCtx.ui.setWidget(WIDGET_KEY, undefined);
		}
		this.registered = false;
		this.tui = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const runs = new Map<string, RunRecord>();
	const fleet = new LoopFleetWidget(runs);

	function notifyCompletion(record: RunRecord): void {
		const header =
			record.status === "finished"
				? `[multiloop_agent ${record.lane}/${record.runTag} finished — ${record.progress.iteration} iterations, ${record.progress.toolUses} tool uses, ${Math.round(record.progress.elapsedMs / 1000)}s]`
				: record.status === "stopped"
					? `[multiloop_agent ${record.lane}/${record.runTag} stopped after ${record.progress.iteration} iterations — loop state on disk remains resumable]`
					: `[multiloop_agent ${record.lane}/${record.runTag} failed: ${record.error}]`;
		pi.sendUserMessage(`${header}\n\n${record.report ?? ""}`.trim(), { deliverAs: "followUp" });
	}

	function listRunLines(): string[] {
		return [...runs.values()].map((record) => {
			const details: LoopAgentDetails = {
				lane: record.lane,
				runTag: record.runTag,
				progress: { ...record.progress, elapsedMs: Date.now() - record.startedAt },
				status: record.status,
			};
			return `${formatProgressLine(details)} — ${record.status}${record.status === "running" ? ` — ${record.progress.activity}` : ""}`;
		});
	}

	pi.on("session_shutdown", async () => {
		for (const record of runs.values()) {
			try {
				await record.session?.abort();
			} catch {
				// child already gone
			}
			try {
				await record.session?.dispose();
			} catch {
				// child already gone
			}
		}
		runs.clear();
		fleet.dispose();
	});

	pi.registerTool({
		name: "multiloop_agent",
		label: "Multiloop Agent",
		description:
			"Run an autonomous pi-multiloop experiment loop in an isolated child Pi session that inherits this session's model. The child loads the pi-multiloop extension and the full local tool set, drives multiloop_start/iterate/measure/decide itself until the stop condition, and reports back. By default the run proceeds in the background: progress shows in the multiloop-agents widget and the report arrives as a follow-up message (parallel runs allowed). Set wait=true to block and receive the report inline. State persists under .multiloop/ and interoperates with the multiloop_* tools and the /multiloop command. Steer a running agent with multiloop_agent_steer; poll or collect reports with multiloop_agent_result; stop with multiloop_agent_stop; list runs with multiloop_agents.",
		promptSnippet: "Run an autonomous multiloop experiment as a background subagent with live fleet progress",
		parameters: Type.Object({
			goal: Type.String({ description: "Specific target outcome for the loop" }),
			verifyCommand: Type.String({ description: "Existing command that prints the primary metric as a number" }),
			lane: Type.Optional(Type.String({ description: "Short stable lane name (default: agent)" })),
			mode: Type.Optional(
				Type.Union(LOOP_MODES.map((mode) => Type.Literal(mode)), {
					description: "Loop mode (default: optimize)",
				}),
			),
			metricDirection: Type.Optional(
				Type.Union([Type.Literal("lower"), Type.Literal("higher")], {
					description: "Whether lower or higher metric values are better (default: the mode's standard direction)",
				}),
			),
			guardCommand: Type.Optional(Type.String({ description: "Optional pass/fail command for regressions" })),
			promptVerifier: Type.Optional(
				Type.String({ description: "Optional correctness criterion that commands cannot capture" }),
			),
			scope: Type.Optional(Type.String({ description: "Files/directories the loop may edit" })),
			protectedPaths: Type.Optional(
				Type.Array(Type.String(), { description: "Repo-relative paths the loop must never modify" }),
			),
			maxIterations: Type.Optional(Type.Number({ description: "Stop after this many completed iterations" })),
			targetMetric: Type.Optional(Type.Number({ description: "Stop when the metric reaches this value" })),
			wait: Type.Optional(
				Type.Boolean({
					description:
						"Wait for the loop to finish and return the report inline (default: false — background run with widget progress and completion notification)",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Resume an existing stopped/paused run instead of starting a new one: a runTag or lane/runTag from .multiloop state. goal/verifyCommand are not required when resuming.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const request = validateLoopAgentArgs(params);
			if (!ctx.model) {
				throw new Error("multiloop_agent needs an active model to run its loop subagent.");
			}
			const resumeTarget = request.resume?.trim();
			const lane = resumeTarget?.includes("/") ? resumeTarget.split("/")[0] : request.lane?.trim() || "agent";
			const runTag = resumeTarget
				? resumeTarget.includes("/")
					? resumeTarget.split("/")[1]
					: resumeTarget
				: `agent-${Date.now().toString(36)}`;
			const firstPrompt = resumeTarget
				? buildResumePrompt(resumeTarget, ctx.cwd)
				: buildLaunchPrompt(request, lane, runTag, ctx.cwd);
			const key = `${lane}/${runTag}`;
			const record: RunRecord = {
				lane,
				runTag,
				goal: request.goal || (resumeTarget ? `resume ${resumeTarget}` : runTag),
				status: "running",
				startedAt: Date.now(),
				progress: initialProgress(),
			};
			runs.set(key, record);
			fleet.setContext(ctx);
			const settled = runLoopAgent(
				record,
				firstPrompt,
				ctx.model,
				ctx.cwd,
				signal,
				params.wait ? onUpdate : undefined,
				ctx,
				() => fleet.update(),
			)
				.then(({ report, progress }) => {
					record.status = record.stopRequested ? "stopped" : "finished";
					record.report = report;
					record.progress = progress;
				})
				.catch((error) => {
					record.status = record.stopRequested ? "stopped" : "failed";
					record.error = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					record.settledAt = Date.now();
					pruneFinished(runs);
					fleet.update();
				});
			record.settled = settled;

			if (params.wait) {
				await settled;
				if (record.status === "failed") throw new Error(`multiloop_agent ${key} failed: ${record.error}`);
				const text = record.status === "finished"
					? (record.report ?? "")
					: `Loop agent ${key} ${record.status} — the loop state under .multiloop/ remains resumable.`;
				return {
					content: [{ type: "text" as const, text }],
					details: { lane, runTag, progress: record.progress, status: record.status, report: record.report },
				};
			}

			void settled.then(() => notifyCompletion(record));
			fleet.update();
			return {
				content: [
					{
						type: "text" as const,
						text: `Loop agent ${key} started in the background. Progress shows in the ${WIDGET_KEY} widget; the report arrives as a follow-up message when the loop ends. Steer it with multiloop_agent_steer (runTag: ${runTag}) or wait for completion.`,
					},
				],
				details: { lane, runTag, progress: record.progress, status: record.status },
			};
		},
		renderCall(args, theme) {
			const lines = [theme.fg("toolTitle", theme.bold("multiloop_agent")) + theme.fg("warning", " Loop subagent running…")];
			if (args.goal) lines.push(theme.fg("dim", `Goal: ${args.goal}`));
			if (args.verifyCommand) lines.push(theme.fg("dim", `Verify: ${args.verifyCommand}`));
			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as LoopAgentDetails | undefined;
			if (isPartial) {
				if (!details) return new Text(theme.fg("warning", "Loop subagent starting…"), 0, 0);
				const line = `${theme.fg("warning", formatProgressLine(details))}\n${theme.fg("dim", `⎿ ${details.progress.activity}`)}`;
				return new Text(line, 0, 0);
			}
			if (details && !details.report) {
				const label = details.status === "running"
					? `Loop agent started — ${details.lane}/${details.runTag}`
					: `Loop agent ${details.status} — ${details.lane}/${details.runTag}`;
				return new Text(theme.fg(details.status === "failed" ? "error" : "success", label), 0, 0);
			}
			const progress = details?.progress;
			const summary = progress
				? `Loop subagent finished — ${progress.iteration} iterations, ${progress.toolUses} tool uses, ${Math.round(progress.elapsedMs / 1000)}s`
				: "Loop subagent finished";
			return new Text(theme.fg("success", summary), 0, 0);
		},
	});

	pi.registerTool({
		name: "multiloop_agent_steer",
		label: "Steer Loop Agent",
		description:
			"Send a mid-run steering message to a running multiloop_agent subagent — change approach, tighten scope, or tell it to wrap up. The message interrupts the child session's current turn.",
		promptSnippet: "Steer a running loop subagent mid-run",
		parameters: Type.Object({
			runTag: Type.String({ description: "Run tag of the running loop agent (from the multiloop_agent start result)" }),
			message: Type.String({ description: "Steering instruction delivered to the child session" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = [...runs.values()].find((candidate) => candidate.runTag === params.runTag);
			if (!record || record.status !== "running" || !record.session) {
				throw new Error(`No running loop agent with runTag "${params.runTag}".`);
			}
			await record.session.prompt(params.message, { streamingBehavior: "steer" });
			return {
				content: [{ type: "text" as const, text: `Steered ${record.lane}/${record.runTag}: ${params.message}` }],
				details: { lane: record.lane, runTag: record.runTag, message: params.message },
			};
		},
	});

	pi.registerTool({
		name: "multiloop_agent_result",
		label: "Loop Agent Result",
		description:
			"Check status and retrieve the report of a multiloop_agent run by runTag. With wait=true, blocks until the run settles; cancelling the wait leaves the agent running and its completion notification still arrives.",
		promptSnippet: "Get a loop subagent's status or final report",
		parameters: Type.Object({
			runTag: Type.String({ description: "Run tag of the loop agent (from the multiloop_agent start result)" }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for the run to settle (default: false)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const record = [...runs.values()].find((candidate) => candidate.runTag === params.runTag);
			if (!record) throw new Error(`No loop agent with runTag "${params.runTag}".`);
			if (params.wait && record.status === "running") {
				await Promise.race([
					record.settled,
					new Promise<void>((resolveWait) => signal?.addEventListener("abort", () => resolveWait(), { once: true })),
				]);
			}
			const details: LoopAgentDetails = {
				lane: record.lane,
				runTag: record.runTag,
				progress: { ...record.progress, elapsedMs: Date.now() - record.startedAt },
				status: record.status,
				report: record.report,
			};
			const statusLine = formatProgressLine(details);
			const text =
				record.status === "running"
					? `${statusLine}\n⎿ ${record.progress.activity}\n(still running; call with wait=true to block)`
					: record.status === "finished"
						? (record.report ?? `${statusLine}\n(finished without a report)`)
						: record.status === "stopped"
							? `${statusLine}\n(stopped; the loop state on disk remains resumable)`
							: `${statusLine}\n(failed: ${record.error})`;
			return { content: [{ type: "text" as const, text }], details };
		},
	});

	pi.registerTool({
		name: "multiloop_agent_stop",
		label: "Stop Loop Agent",
		description:
			"Immediately stop a running multiloop_agent subagent by aborting its child session. The loop state under .multiloop/ stays resumable; prefer multiloop_agent_steer with a wrap-up instruction for a graceful stop with a report.",
		promptSnippet: "Stop a running loop subagent immediately",
		parameters: Type.Object({
			runTag: Type.String({ description: "Run tag of the running loop agent" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = [...runs.values()].find((candidate) => candidate.runTag === params.runTag);
			if (!record || record.status !== "running" || !record.session) {
				throw new Error(`No running loop agent with runTag "${params.runTag}".`);
			}
			record.stopRequested = true;
			await record.session.abort();
			return {
				content: [
					{
						type: "text" as const,
						text: `Stopped ${record.lane}/${record.runTag}. The loop state under .multiloop/ remains resumable (spawn with resume: \"${record.lane}/${record.runTag}\").`,
					},
				],
				details: { lane: record.lane, runTag: record.runTag, progress: record.progress, status: record.status },
			};
		},
	});

	pi.registerTool({
		name: "multiloop_agents",
		label: "List Loop Agents",
		description:
			"List multiloop_agent runs known to this session: running agents with live progress plus recent finished, stopped, and failed runs.",
		promptSnippet: "List loop subagents and their status",
		parameters: Type.Object({}),
		async execute() {
			const records = [...runs.values()];
			if (records.length === 0) {
				return { content: [{ type: "text" as const, text: "No loop agents in this session." }], details: { runs: [] } };
			}
			return {
				content: [{ type: "text" as const, text: listRunLines().map((line) => `- ${line}`).join("\n") }],
				details: { runs: records.map(({ lane, runTag, status }) => ({ lane, runTag, status })) },
			};
		},
	});

	pi.registerCommand("multiloop-agents", {
		description: "List loop subagent runs: live progress for running agents plus recent terminal runs",
		async handler(_args, ctx) {
			const lines = listRunLines();
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No loop agents in this session.", "info");
		},
	});
}
