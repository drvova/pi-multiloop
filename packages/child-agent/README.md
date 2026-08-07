# @multiloop/child-agent

The shared, isolated child-agent session core for Pi subagents: session spawn,
resource isolation, abort discipline, and report extraction. One engine under
`@multiloop/agent` (and, in the Lynx monorepo, the librarian — kept in sync by
hand; the copy there is `@lynx/child-agent`).

## API

- `createIsolatedResourceLoader({ cwd, systemPrompt, extensionFactories? })` —
  a `DefaultResourceLoader` with every discovery channel disabled; the child
  sees only the given system prompt and explicitly injected inline extensions.
- `createChildAgentSession(spec, createSession?)` — an isolated, in-memory
  session via `createAgentSession`; `createSession` is the test seam.
- `promptChildAgent(session, text, signal, abortError)` — disciplined aborts:
  a pre-aborted signal rejects before any turn, a mid-prompt abort awaits
  `session.abort()` before rejecting, and the listener is always removed.
- `extractLastAssistantText(session, fallback)` — the child's final report.

TypeScript source, typecheck-only; Pi loads it through the importing
extension's jiti compile. No build step.
