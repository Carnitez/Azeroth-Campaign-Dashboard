# Azeroth Campaign Dashboard

A local-first World of Warcraft campaign tracker for completionists and gold makers.

**Live dashboard:** https://azeroth-campaign-dashboard.vercel.app

## What it tracks

- Multiple characters, realms, regions, classes, specs, and professions
- Level, location, liquid gold, and time played
- Achievements, mounts, pets, toys, appearances, and reputations
- Three-part campaign objectives and completion status
- Play-session journal with gold changes and notes
- Gold activities with revenue, costs, profit, and measured profit per hour
- Gold-balance history and collection gains since baseline
- JSON backup export and import
- Character-aware class and race accent themes
- Recoverable deletion for objectives, journal entries, gold activities, and characters
- A decision-oriented Command Center with ranked next actions, active goals, weekly momentum, roster attention, and a unified activity feed

Carnitez-Silvermoon EU is included as the initial campaign character. All data is stored in the browser with `localStorage`; no account or login is required.

## Interface

The dashboard uses a compact campaign-management shell with a persistent desktop sidebar and a responsive mobile navigation layout. The Command Center derives its recommendations and weekly summaries from canonical v2 campaign data without storing a second copy. The active character's class selects the accent, progress, focus, surface, motif, and icon tokens; Night Elf characters add a restrained moonlit influence. Theme selection is derived from existing character fields, so older saved campaigns remain compatible.

Use `Alt+1` through `Alt+4` to move between Command Center, Collections, Gold, and Journal from the keyboard.

## Run locally

```bash
npm run dev
```

Then open `http://127.0.0.1:4173`.

## Build

```bash
npm run build
```

The static site is generated in `dist/` and is ready for Vercel.

## Privacy

Progress stays in the browser that recorded it. Export a JSON backup before clearing browser data or changing devices.

## Data safety

The dashboard now stores validated schema-v2 state under `azeroth-command-center-v2`. Existing `azeroth-command-center-v1` data is never changed or removed; it is migrated into v2 on first load and the exact original string is kept once under `azeroth-command-center-v1-recovery`. Malformed or future-version data opens an explicit recovery view instead of being replaced with starter data. Character removal archives the character from the active roster while retaining its goals, activities, progress events, and collection trackers. Use `npm test` to run the migration, validation, persistence, selector, gold, and local-date tests.
