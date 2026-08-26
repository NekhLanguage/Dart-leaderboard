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
- **Self-service score entry** — pick your name from the dropdown of registered
  players (the default), or explicitly add a new one (de-duplicated so nobody
  ends up with two entries), choose any day (past or future), and save.
  Existing scores can be updated or removed.
- **Player management** — merge a misspelled duplicate into the right player
  (their scores move over; if both scored the same day the higher score is
  kept) or delete a player and their scores entirely.
- **Per-league records** — the "record single day" resets between the Spring
  and Autumn leagues instead of persisting forever.
- **Match mode (x01)** — play 201/301/…/1001 with any registered players: tap
  the on-screen dartboard where each dart landed and the app does the math.
  First to exactly 0 wins and the last dart must be a double (inner bull
  counts). No busts — a dart that would overshoot, land on 0 without a double,
  or leave 1 simply doesn't count, and darts apply in the order thrown.
  Matches are a live scorer only; nothing is saved to the league stats.
- **Shared & live** — data is stored server-side and every browser polls for
  updates, so the office TV and everyone's laptop stay in sync.

## How it works

| Layer        | Tech                                                            |
| ------------ | -------------------------------------------------------------- |
| Front end    | Static HTML / CSS / vanilla JS in `public/`                    |
| API          | A single [Netlify Function](netlify/functions/api.mts)         |
| Storage      | [Netlify Blobs](https://docs.netlify.com/blobs/overview/) — a shared, strongly-consistent store. The leaderboard lives in a durable site-wide store that survives deploys; only deploy previews and branch deploys get an isolated deploy-scoped store (detected via the runtime deploy context — `process.env.CONTEXT` only exists at build time). |

No database to manage and no logins — perfect for an honour-system office board.

### API

- `GET /api/data` — returns `{ players, scores }`.
- `POST /api/score` — body `{ name, date: "YYYY-MM-DD", value }`. Creates the
  player if new (matched case-insensitively) and upserts that day's score.
- `DELETE /api/score` — body `{ name, date }`. Removes that day's score.
- `DELETE /api/player` — body `{ id }`. Removes a player and all their scores.
- `POST /api/player/merge` — body `{ fromId, intoId }`. Moves every score from
  one player onto another (same-day clashes keep the higher value), then
  removes the `from` player.
- `GET /api/admin/import-deploy?deployId=…` — one-time recovery: merges the
  leaderboard data stored on an old deploy (from before the durable-storage
  fix) into the current store. Idempotent; the deploy id is shown in the
  Netlify UI under Deploys.

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
