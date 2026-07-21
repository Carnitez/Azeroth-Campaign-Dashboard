# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A zero-dependency, local-first World of Warcraft campaign tracker (Command Center, Daily
Agenda, Activities, Collections, Gold, Journal). Vanilla JS ES modules, no framework, no npm
runtime dependencies. Node >= 20. All state lives in the browser's `localStorage`. Deployed to
Vercel, redeployed on every push to `main`.

## Commands

- `npm run build` — concatenates `src/base.css` + six `.mjs` engine modules + `src/dashboard.html`
  into a single static `dist/index.html` via `scripts/build.mjs`.
- `npm run dev` — serves the built app locally (`http://127.0.0.1:4173`).
- `npm test` — `node --test` (160 tests) with `scripts/pin-test-timezone.mjs` preloaded via
  `--import` to pin the timezone to `Europe/Amsterdam` so local-date/time assertions don't
  depend on the host's or CI's configured timezone.
  - Single file: `npm test -- test/schedule-engine.test.mjs`; filter by name: `npm test -- --test-name-pattern="local Monday"`
- `npm run check` — builds, then `scripts/check.mjs` greps `dist/index.html` for required
  markup/behavior (persistence, multi-character controls, theming, no native `alert`/`confirm`)
  and syntax-checks every non-module inline `<script>`.
- Both `npm test` and `npm run check` must pass before any commit.

## Architecture

Six pure `.mjs` modules under `src/` hold all domain logic; `dashboard.html` holds all markup,
UI wiring, and view CSS; `base.css` holds design tokens.

- `core.mjs` — schema-v2 state shape, v1→v2 migration, validation, persistence helpers.
- `schedule-engine.mjs` — anchor-based schedules, local-time due states, pause/snooze/skip, history.
- `recommendation-engine.mjs` — the one deterministic scoring system shared by the Command
  Center, Daily Agenda, and session planner. Scores are derived at read time, never persisted.
- `activity-engine.mjs` — planned/logged activities; session planning delegates ranking to
  `recommendation-engine.mjs`.
- `session-engine.mjs` — session runner: pause/resume timing, per-activity results, history.
- `selectors.mjs` — read-only selectors composing the above for the UI; never mutates state.

**Module loading has two modes.** Each engine module ends with `globalThis.AzerothX = X`, and
dependents do `const Core = globalThis.AzerothCore ?? await import('./core.mjs')`. In the built
`dist/index.html` each module is its own separate `<script type="module">` tag (see
`build.mjs`), so modules hand off through `globalThis` in load order (core → schedule →
recommendation → activity → session → selectors → dashboard) rather than importing each other.
In tests, modules import each other directly as real ES modules, so the `await import` fallback
runs instead. Preserve this pattern and load order when adding a module or cross-module call.

## Hard rules

- Never add a runtime dependency; never break the single-file `dist/index.html` output (the
  only allowed external network reference is the Lucide icon script tag).
- `localStorage` under `azeroth-command-center-v2` holds all state. `azeroth-command-center-v1`
  is never mutated/removed — migrated into v2 on first load, original kept once under
  `azeroth-command-center-v1-recovery`.
- Derived data (recommendation scores, agenda availability, insights) is never persisted.
- New top-level state collections must be optional so existing saves keep loading (see
  `normalizeV2State` in `core.mjs`).
- Recommendation history is bounded (200 records / 180 days); dismissing a suggestion never
  deletes its source activity, goal, collection, or session.
