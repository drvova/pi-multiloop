import { it, expect } from "vitest";
import { createChildAgentSession } from "../../child-agent/src/index.js";
import multiloopExtension from "../extensions/pi-multiloop/index.js";

/**
 * Regression: a caller-supplied isolated resource loader is never reloaded by
 * createAgentSession (the SDK guards reload behind `if (!resourceLoader)`),
 * so inline extensionFactories were silently never invoked — the Loop Runner
 * child reported "multiloop_* tools are not bound in my session" after 629s
 * of discovery (case_fda10268b9). createChildAgentSession must reload the
 * loader itself so the injected factories run and register their tools.
 */
it("binds injected extension tools into the child session (case_fda10268b9 regression)", async () => {
  const session = await createChildAgentSession({
    cwd: process.cwd(),
    model: undefined as any,
    systemPrompt: "probe",
    tools: ["read", "multiloop_start", "multiloop_iterate"],
    extensionFactories: [multiloopExtension],
  });
  const anySession = session as any;
  const registry: Map<string, unknown> = anySession._toolRegistry;
  const registered = registry instanceof Map ? [...registry.keys()] : [];
  expect(registered).toContain("multiloop_start");
  expect(registered).toContain("multiloop_iterate");
  expect(registered).toContain("read");
});
