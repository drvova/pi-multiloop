# pi-multiloop monorepo

This document records the repository structure and the decisions behind it.
It exists so the next change starts from the recorded reasoning instead of
rediscovering it.

## Structure

```
pi-multiloop/                       # pi-multiloop (published npm + pi package, workspaces root)
├── package.json                    # published manifest: pi key, bin, files, workspaces, shared devDeps
├── tsconfig.base.json              # shared compilerOptions (noEmit; typecheck-only repo)
├── tsconfig.json                   # include: packages/**/*.ts
├── vitest.config.ts                # single test runner; globalSetup inside packages/multiloop/tests
├── packages/
│   ├── multiloop/                  # @multiloop/extension (private)
│   │   ├── extensions/pi-multiloop/  # extension source (index, loop, lanes, state, metrics, modes, ...)
│   │   ├── tests/                  # vitest suites + support harnesses
│   │   └── package.json            # pi manifest: extensions
│   ├── multiloop-skill/            # @multiloop/skill (private)
│   │   ├── skills/multiloop/       # skill.md + references/LOOP_GUIDE.md
│   │   └── package.json            # pi manifest: skills
│   ├── multiloop-run/              # @multiloop/run (private)
│   │   ├── bin/multiloop-run.mjs   # detached headless driver (+ .d.mts types)
│   │   └── package.json            # bin manifest
│   ├── multiloop-agent/            # @multiloop/agent (private)
│   │   ├── extensions/multiloop-agent/  # subagent extension source (index.ts)
│   │   └── package.json            # pi manifest: extensions
│   └── child-agent/                # @multiloop/child-agent (private)
│       ├── src/index.ts            # isolated child-session core (spawn, isolation, aborts, extraction)
│       └── package.json            # library manifest
├── scripts/                        # e2e harnesses (manual)
└── docs/                           # PLAN, STATE, TODO, FEEDBACK, PUBLISH, MONOREPO
```

## Why the root stays the published package

The package is distributed two ways, and both read the **root** `package.json`:

1. `npm install pi-multiloop` — npm reads `files`, `bin`, `peerDependencies`.
2. `pi install git:github.com/drvova/pi-multiloop` — pi clones the repo and
   reads the root `pi` manifest to find extensions and skills.

Pi manifest paths are relative to the package root, so the root manifest
points into `packages/`:

```json
"pi": {
  "extensions": ["./packages/multiloop/extensions"],
  "skills": ["./packages/multiloop-skill/skills"]
}
```

The sub-packages exist for workspace organization and are `private: true` —
nothing is published from `packages/` directly. A consumer's view does not
change: the same extension, skill, and `multiloop-run` binary ship in the
same release artifact.

## Import geometry (why tests moved without edits)

Tests import the extension through relative paths like
`../extensions/pi-multiloop/loop.js`. Moving `extensions/` and `tests/`
together into `packages/multiloop/` kept every one of those imports valid —
the relative depth is unchanged. Two references crossed the package boundary
and were updated by hand:

- `tests/driver.test.ts` imports the driver:
  `../../multiloop-run/bin/multiloop-run.mjs` (resolved through its `.d.mts`).
- `scripts/e2e-optimize.sh` invokes the driver by absolute path from the
  repository root.

## Decisions

- **D1 — One package per existing seam.** Extension, skill, detached driver.
  These were already separate distribution surfaces (pi extension, pi skill,
  npm bin); the layout now says so. No speculative packages.
- **D2 — Root remains the release unit.** Git-based pi installs read only the
  root manifest, so publishing stays at the root and sub-packages stay
  private. This preserves `pi install git:...` and `pi update` for every
  existing installation.
- **D3 — Typecheck-only TypeScript.** Pi loads the extension from TypeScript
  source at runtime; there is no build step. `tsconfig.base.json` therefore
  sets `noEmit` and drops the emit-only options (`outDir`, `rootDir`,
  `declaration`, `sourceMap`) and a stale `paths` block that pointed at one
  developer's global npm directory.
- **D4 — One vitest at the root.** Tests live beside the extension (95% of
  them exercise it) and share `tests/support/`. A single root
  `vitest.config.ts` keeps `npx vitest run` and CI identical to before.
- **D5 — Shared devDependencies at the root.** typescript, vitest, and the pi
  packages stay hoisted at the root (pi-mono's convention); sub-packages
  declare only peerDependencies.

## Verification

```bash
npm install
npx tsc --noEmit     # typecheck across packages/**
npx vitest run       # full suite; seed echoed at startup
pi install .         # the repo installs itself as a pi package from the new paths
```

`scripts/e2e-optimize.sh` remains a manual end-to-end (spawns real `pi`
sessions, takes minutes) and now drives
`packages/multiloop-run/bin/multiloop-run.mjs`.
