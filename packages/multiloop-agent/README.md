# @multiloop/agent

Autonomous pi-multiloop subagents for Pi: background loop execution in
isolated child Pi sessions, with a live fleet widget, completion
notifications, mid-run steering, and a management toolset — every subagent
drives a real pi-multiloop experiment loop.

## What it does

Calling `multiloop_agent` from any Pi session:

1. Spawns an isolated child session that inherits the caller's **current
   model** (`ctx.model`) unchanged, via the shared `@multiloop/child-agent`
   core (`packages/child-agent`).
2. Loads the pi-multiloop extension (and nothing else — no user extensions,
   skills, prompts, themes, or context files) into the child.
3. Gives the child the full local tool set (`read`, `bash`, `edit`, `write`,
   `grep`, `find`, `ls`) plus all ten `multiloop_*` tools, and a Loop Runner
   system prompt that drives the start → iterate → measure → decide cadence.
4. Streams live progress to the persistent `multiloop-agents` below-editor
   widget (pi-subagents style: animated spinner, tree layout, per-agent stats,
   terminal status icons with a linger window, self-removal when idle).
5. On completion, delivers the child's report as a follow-up message
   (background default) or inline result (`wait: true`).

Loop state persists under `.multiloop/` in the working directory, so runs are
visible to and interoperable with the parent session's `multiloop_*` tools and
the `/multiloop` command.

## Tools

| Tool | Purpose |
| --- | --- |
| `multiloop_agent` | Spawn a loop run (background by default; `wait: true` blocks; `resume: "lane/runTag"` revives a stopped/paused run) |
| `multiloop_agent_result` | Status or report by runTag; cancellable `wait` |
| `multiloop_agent_steer` | Steering message mid-run, interrupting the child's current turn |
| `multiloop_agent_stop` | Immediate abort; loop state stays resumable |
| `multiloop_agents` | List the session's runs with status and progress |

Plus the `/multiloop-agents` command for the run table in the TUI.

## Install

Ships with the `pi-multiloop` package (the root manifest loads it). On its own
from a clone:

```bash
pi install ./packages/multiloop-agent
```

## Development

```bash
npm run typecheck   # repo-wide tsc --noEmit covers this package
npx vitest run      # the loop engine's suites
```
