import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
	type ResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Specification for an isolated child agent session: the child sees only what
 * the caller injects — no user extensions, skills, prompts, themes, or
 * project files.
 */
export interface ChildAgentSpec {
	cwd: string;
	model: Model<any>;
	systemPrompt: string;
	/** Enabled tool names (built-ins, custom tools, and extension tools). */
	tools?: string[];
	/** SDK custom tools registered outside extensions. */
	customTools?: ToolDefinition[];
	/** Inline extensions loaded into the child (factories run with full pi APIs). */
	extensionFactories?: ExtensionFactory[];
}

export type ChildAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Injectable session factory seam for tests. */
export type ChildAgentSessionFactory = (
	options: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: ChildAgentSession }>;

/**
 * An isolated resource world for a child agent: every discovery channel is
 * disabled; the only content is the caller's system prompt and any explicitly
 * injected inline extensions.
 */
export function createIsolatedResourceLoader(spec: {
	cwd: string;
	systemPrompt: string;
	extensionFactories?: ExtensionFactory[];
}): ResourceLoader {
	return new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: spec.extensionFactories ?? [],
		systemPrompt: spec.systemPrompt,
	});
}

/** Create an isolated, in-memory child agent session. */
export async function createChildAgentSession(
	spec: ChildAgentSpec,
	createSession: ChildAgentSessionFactory = createAgentSession,
): Promise<ChildAgentSession> {
	const resourceLoader = createIsolatedResourceLoader(spec);
	// No explicit reload here: createAgentSession reloads the loader internally
	// (sdk.js), and a pre-reload would run package-manager discovery twice.
	const { session } = await createSession({
		cwd: spec.cwd,
		model: spec.model,
		sessionManager: SessionManager.inMemory(spec.cwd),
		resourceLoader,
		tools: spec.tools,
		customTools: spec.customTools,
	});
	return session;
}

interface MessageLike {
	role: string;
	content?: string | Array<{ type: string; text?: string }>;
}

/** The last assistant text of a child transcript, or `fallback` when there is none. */
export function extractLastAssistantText(session: { messages: MessageLike[] }, fallback: string): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		const blocks = typeof message.content === "string" ? [] : (message.content ?? []);
		const text = blocks
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return fallback;
}

/**
 * Prompt a child session with disciplined abort handling: a pre-aborted signal
 * rejects before any turn runs, an abort mid-prompt awaits session.abort()
 * before rejecting, and the listener is always removed.
 */
export async function promptChildAgent(
	session: ChildAgentSession,
	text: string,
	signal: AbortSignal | undefined,
	abortError: () => Error,
): Promise<void> {
	if (signal?.aborted) throw abortError();
	let aborted = false;
	let abortPromise: Promise<void> | undefined;
	const abort = () => {
		aborted = true;
		abortPromise ??= session.abort().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) {
			abort();
			await abortPromise;
			throw abortError();
		}
		await session.prompt(text);
		if (aborted || signal?.aborted) {
			abort();
			await abortPromise;
			throw abortError();
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		await abortPromise;
	}
}
