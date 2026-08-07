import { describe, it, expect } from "vitest";
import multiloopExtension from "../extensions/pi-multiloop/index.js";
import { MULTILOOP_TOOLS } from "../../multiloop-agent/extensions/multiloop-agent/index.js";

/**
 * Organism boundary check: the fleet allowlist (multiloop-agent's
 * MULTILOOP_TOOLS) must mirror the tools the pi-multiloop extension actually
 * registers. This seam failed once already — the mesh tools were registered
 * in the extension but invisible to Loop Runner children because nobody
 * updated the allowlist. Exact set equality in both directions means:
 *  - a new extension tool never ships silently hidden from the fleet;
 *  - a stale/typo'd allowlist entry never points at a tool that does not exist.
 * If a future tool is genuinely parent-only, exclude it explicitly in
 * PARENT_ONLY_TOOLS so the decision is documented in code, not implicit.
 */
const PARENT_ONLY_TOOLS: string[] = [];

function registeredMultiloopTools(): string[] {
  const tools: string[] = [];
  const piStub = {
    registerTool: (def: { name: string }) => {
      tools.push(def.name);
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: () => {},
    // Registration-time surface captured from the extension default export:
    // registerTool/on/registerCommand/registerMessageRenderer only. Anything
    // else the extension starts calling at registration should be added here
    // deliberately, not via a permissive proxy.
  };
  multiloopExtension(piStub as never);
  return tools.filter((name) => name.startsWith("multiloop_"));
}

describe("fleet tool allowlist sync", () => {
  it("every registered multiloop_* tool is allowlisted for fleet children", () => {
    const registered = registeredMultiloopTools();
    const missing = registered.filter(
      (name) => !MULTILOOP_TOOLS.includes(name as never) && !PARENT_ONLY_TOOLS.includes(name)
    );
    expect(missing).toEqual([]);
  });

  it("every allowlisted tool is actually registered by the extension", () => {
    const registered = new Set(registeredMultiloopTools());
    const phantom = MULTILOOP_TOOLS.filter((name) => !registered.has(name));
    expect(phantom).toEqual([]);
  });

  it("the mesh tools are allowlisted (regression: they shipped hidden once)", () => {
    expect(MULTILOOP_TOOLS).toContain("multiloop_send");
    expect(MULTILOOP_TOOLS).toContain("multiloop_inbox");
  });
});
