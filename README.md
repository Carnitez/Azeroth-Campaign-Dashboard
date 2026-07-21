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
- A decision-oriented Command Center with history-aware ranked actions, plain-language explanations, bounded suggestion fatigue, active goals, weekly momentum, roster attention, and a unified activity feed
- Character-scoped activities with priorities, schedules, repeat cadence, tags, completion, and filtering
- A deterministic play-session planner for 15- to 120-minute sessions with focused, balanced, maximum-completion, gold, and campaign strategies
- Saved session plans with editable order, timing, activity snapshots, notes, duplication, and safe draft deletion
- A focused session runner with pause/resume timing, per-activity results, review, linked gold and progress, and durable history
- A global command palette that searches live campaign records and runs existing dashboard actions
- A Daily Agenda with active/all-character scope, recommended or manual ordering, calm attention states, seven-day projection, multi-select session building, and time-limited planning
- Activity insights derived from recorded outcomes, using minimum sample thresholds and median durations to resist outliers
- Anchor-based one-time, daily, weekly, selected-weekday, interval, and manual schedules with local-time due states, pause, snooze, skip, and reusable run history

Carnitez-Silvermoon EU is included as the initial campaign character. All data is stored in the browser with `localStorage`; no account or login is required.

## Interface

The dashboard uses a compact campaign-management shell with a persistent desktop sidebar and a responsive mobile navigation layout. The Command Center, Agenda, and planner share one deterministic scoring system. It derives priorities and insights from canonical v2 campaign history; scores themselves are never stored. Suggestion impressions and explicit feedback stay locally in a bounded optional history collection. The active character's class selects the accent, progress, focus, surface, motif, and icon tokens; Night Elf characters add a restrained moonlit influence. Theme selection is derived from existing character fields, so older saved campaigns remain compatible.

Use `Ctrl+K` or `Cmd+K` to open the command palette. Use `Alt+1` through `Alt+6` to move between Command Center, Collections, Gold, Journal, Activities, and Daily Agenda from the keyboard. While the session runner is open, `Space` pauses or resumes, `Enter` opens the current result form, `S` skips the current item, and `N` focuses the quick note field.

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

The dashboard stores validated schema-v2 state under `azeroth-command-center-v2`. Existing `azeroth-command-center-v1` data is never changed or removed; it is migrated into v2 on first load and the exact original string is kept once under `azeroth-command-center-v1-recovery`. Saved sessions, occurrence history, and recommendation history are optional v2 collections, so existing v2 campaigns continue loading unchanged. Recommendation history is pruned to 200 records and 180 days, and dismissing a suggestion never deletes its source activity, goal, collection, or session. Agenda availability and all recommendation scores are derived and are never written as duplicated state. Malformed or future-version data opens an explicit recovery view instead of being replaced with starter data. Character removal archives the character from the active roster while retaining its goals, activities, progress events, collection trackers, and session history. Use `npm test` to run the migration, validation, persistence, scheduling, recommendation, session, selector, gold, and local-date tests.
