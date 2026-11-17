# Blocklands — working notes for Claude

Original voxel sandbox in the browser. Core gameplay: multi-block structures (physical ships, kinematic rotors) held together by auto-sticking rules and glue.

Read before changing code: `docs/ARCHITECTURE.md` (code conventions, layering, tick order), `docs/DESIGN.md` (gameplay rules), `docs/LESSONS.md` (bugs the prototype had), `docs/ACCEPTANCE.md` (scenarios, automated in `tests/acceptance/`), `docs/ROADMAP.md` (milestones).

## Tracking

- Scope, progress and leftovers live in `docs/ROADMAP.md` only. GitHub issues and milestones are not used (owner's decision, 2026-11-17).
- At the start of a session, fetch the latest `main` before reading the docs.

## Commands

- `npm test` — every headless test, including the 24 acceptance scenarios
- `npm run typecheck`
- `npm run build:artifact` — single-file build, `dist-artifact/blocklands.html`
- `node scripts/e2e-smoke.mjs` — browser smoke test (WebGL2 and WebGPU launch configurations)

## Running subagents (owner's standing preferences, stated 2026-11-17)

- Coding and bug-fixing subagents: Opus at `high` effort by default.
- Problems the lead judges hard (ship physics, netcode, shape-aware collision and the like) may be escalated to `xhigh` or to Fable.
- Use fewer test and review agents than Milestone 1 did, without giving up product quality. Milestone 1 ran one implementer, two adversarial reviewers and a fixer per module at `xhigh`, about 1–2M tokens per module. Prefer: implementers write their own tests (acceptance tests included), one reviewer per module, extra audits only for the hardest modules.
- Subagents never run git commands that change state; the lead commits and pushes.

## Refactoring policy (owner, stated 2026-11-17)

- No backward compatibility is required: not for saves, not for internal APIs, not for earlier milestones. When a design is wrong or a better one exists, tear it down and refactor in one go; do not add migration shims or keep an old path alive beside the new one.

## Design philosophy (owner)

- The player interacts with ONE block, or one face of it, at a time. Multi-block structures are the heart of the game, but each starts from a single block (helm, bearing, blast crate). Avoid tools that select or act on a region.
- Names, textures and UI are original; nothing imitates Minecraft.
