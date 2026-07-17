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

Carnitez-Silvermoon EU is included as the initial campaign character. All data is stored in the browser with `localStorage`; no account or login is required.

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
