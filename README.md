# 🎯 Office Darts League

A good-looking **weekly leaderboard** for an office darts competition. Anyone can
fill in their own score for each day — including past and future days, for when
people don't play every day — and everyone in the office sees the **same shared
stats** in real time.

## Features

- **Weekly leaderboard** with a Mon–Sun breakdown, medals for the top three, and
  a live ranking bar.
- **Browse any week** with the ‹ / › navigator, or jump back to the current week.
- **Season totals** view: total points, days played, average per day, best single
  day, and how many weeks each player has won (across all weeks).
- **Self-service score entry** — pick your name from the list or add a new one
  (de-duplicated so nobody ends up with two entries), choose any day (past or
  future), and save. Existing scores can be updated or removed.
- **Shared & live** — data is stored server-side and every browser polls for
  updates, so the office TV and everyone's laptop stay in sync.

## How it works

| Layer        | Tech                                                            |
| ------------ | -------------------------------------------------------------- |
| Front end    | Static HTML / CSS / vanilla JS in `public/`                    |
| API          | A single [Netlify Function](netlify/functions/api.mts)         |
| Storage      | [Netlify Blobs](https://docs.netlify.com/blobs/overview/) — a shared, strongly-consistent store. Production uses a global store; preview/branch deploys use an isolated deploy-scoped store so test data never touches the real leaderboard. |

No database to manage and no logins — perfect for an honour-system office board.

### API

- `GET /api/data` — returns `{ players, scores }`.
- `POST /api/score` — body `{ name, date: "YYYY-MM-DD", value }`. Creates the
  player if new (matched case-insensitively) and upserts that day's score.
- `DELETE /api/score` — body `{ name, date }`. Removes that day's score.

## Local development

```bash
npm install
npm run dev      # netlify dev — serves the site + functions + local Blobs
```

Then open the printed local URL.

## Deploy

This repo is set up for Netlify. Connect it to a Netlify project (or use the
Netlify CLI / MCP) and deploy — `netlify.toml` already points at the `public/`
publish directory and the `netlify/functions/` directory. Blobs are provisioned
automatically; there's nothing to configure.
