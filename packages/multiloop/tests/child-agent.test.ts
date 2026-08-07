import { describe, it, expect } from "vitest";
import {
  createChildAgentSession,
  createIsolatedResourceLoader,
  extractLastAssistantText,
  promptChildAgent,
} from "../../child-agent/src/index.js";

/**
 * The session core's safety contract. promptChildAgent's abort discipline is
 * what keeps a stopped fleet child from hanging a turn forever, and the
 * isolated loader is the whole reason the package exists (the child sees only
 * what the caller injects). Both shipped with zero coverage despite the
 * injectable ChildAgentSessionFactory seam built for exactly this.
 */

function fakeModel() {
  return { provider: "test", id: "fake" } as never;
}

describe("createIsolatedResourceLoader", () => {
  it("disables every discovery channel and carries only injected content", () => {
    const factory = () => {};
    const loader = createIsolatedResourceLoader({
      cwd: "/tmp/x",
      systemPrompt: "you are the child",
      extensionFactories: [factory],
    }) as unknown as Record<string, unknown>;

    // Isolation contract: nothing leaks in from user or project config.
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect(loader.noThemes).toBe(true);
    expect(loader.noContextFiles).toBe(true);
    expect(loader.systemPromptSource).toBe("you are the child");
    expect(loader.extensionFactories).toEqual([factory]);
  });
});

describe("createChildAgentSession", () => {
  it("passes an isolated loader and in-memory session to the SDK, with no modelRuntime (SDK drift regression)", async () => {
    let captured: Record<string, unknown> | undefined;
    const marker = { marker: true };
    const session = await createChildAgentSession(
      {
        cwd: "/tmp/x",
        model: fakeModel(),
        systemPrompt: "prompt",
        tools: ["read"],
        customTools: [],
      },
      async (options) => {
        captured = options as Record<string, unknown>;
        return { session: marker as never };
      }
    );

    expect(session).toBe(marker);
    expect(captured?.cwd).toBe("/tmp/x");
    expect(captured?.tools).toEqual(["read"]);
    expect(captured?.resourceLoader).toBeDefined();
    expect(captured?.sessionManager).toBeDefined();
    // The installed SDK removed modelRuntime; passing it must not regrow.
    expect("modelRuntime" in (captured ?? {})).toBe(false);
  });
});

describe("extractLastAssistantText", () => {
  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  it("returns the last assistant message's text", () => {
    const session = {
      messages: [assistant("first"), { role: "user", content: "go" }, assistant("final report")],
    };
    expect(extractLastAssistantText(session, "fallback")).toBe("final report");
  });

  it("skips assistant messages with no text blocks (e.g. tool-call-only turns)", () => {
    const session = {
      messages: [
        assistant("earlier text"),
        { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      ],
    };
    expect(extractLastAssistantText(session as never, "fallback")).toBe("earlier text");
  });

  it("falls back when no assistant text exists, including string content", () => {
    expect(
      extractLastAssistantText({ messages: [{ role: "assistant", content: "plain string" }] }, "fallback")
    ).toBe("fallback");
    expect(extractLastAssistantText({ messages: [{ role: "user", content: "hi" }] }, "fallback")).toBe("fallback");
    expect(extractLastAssistantText({ messages: [] }, "fallback")).toBe("fallback");
  });
});

describe("promptChildAgent", () => {
  const abortError = () => new Error("aborted");

  function fakeSession(behavior: { onPrompt?: () => void } = {}) {
    const calls = { prompt: 0, abort: 0 };
    const session = {
      async prompt(_text: string) {
        calls.prompt++;
        behavior.onPrompt?.();
      },
      async abort() {
        calls.abort++;
      },
    };
    return { session, calls };
  }

  it("resolves on a clean turn and removes the abort listener afterwards", async () => {
    const controller = new AbortController();
    const { session, calls } = fakeSession();
    await promptChildAgent(session as never, "do work", controller.signal, abortError);
    expect(calls).toEqual({ prompt: 1, abort: 0 });

    // Listener removed: aborting after completion must not touch the session.
    controller.abort();
    expect(calls.abort).toBe(0);
  });

  it("rejects before any turn when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { session, calls } = fakeSession();
    await expect(promptChildAgent(session as never, "do work", controller.signal, abortError)).rejects.toThrow("aborted");
    expect(calls).toEqual({ prompt: 0, abort: 0 });
  });

  it("aborts the session and rejects when the signal fires mid-prompt", async () => {
    const controller = new AbortController();
    const { session, calls } = fakeSession({ onPrompt: () => controller.abort() });
    await expect(promptChildAgent(session as never, "do work", controller.signal, abortError)).rejects.toThrow("aborted");
    expect(calls.prompt).toBe(1);
    expect(calls.abort).toBe(1);
  });

  it("works without a signal", async () => {
    const { session, calls } = fakeSession();
    await promptChildAgent(session as never, "do work", undefined, abortError);
    expect(calls).toEqual({ prompt: 1, abort: 0 });
  });
});
