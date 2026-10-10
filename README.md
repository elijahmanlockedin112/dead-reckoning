# Dead Reckoning

A text adventure where Gemini is the dungeon master, you name the world, and the
map draws itself from nothing but the directions you travel.

*Dead reckoning* is navigation without landmarks — you know where you are only
because you logged every move that got you there. That's literally how the chart
in this app works: the model never sends coordinates, only which way you went.

## Run it

Needs Node 18 or newer. No dependencies, no install step, no config file.

```bash
cd "dead-reckoning"
node server.mjs
```

Open <http://localhost:4700> and paste your API key into the card on the start
screen. Get one free at <https://aistudio.google.com/apikey>.

## Your key

Paste it into the app. The page hands it to your local server, which checks it
against Google before accepting it — a bad key is rejected with the real reason
rather than failing later on your first move. The header pill shows which key is
loaded (last four characters only) and lets you replace or forget it.

Tick **remember on this machine** and it's written to `.env` beside
`server.mjs`, so you only do this once. That file is gitignored, and it's only
written *after* the key verifies. Untick it and the key lives in the server
process and dies with it.

`GEMINI_API_KEY` as an environment variable still works and needs no UI. When
several are present, a key typed into the app wins, then the environment
variable, then `.env`.

The key is never stored in the browser — no `localStorage`, no cookie. It's
scrubbed out of any error text before that text is sent to the page. The server
binds to `127.0.0.1` only, so nothing else on your network can reach it.

## What it does

- **You seed the world.** Pick a preset or write your own — "a cathedral grown
  from a single fossil, still growing". The seed becomes the model's system
  instruction for the whole run.
- **Structured turns.** Every turn comes back as validated JSON via Gemini's
  `responseSchema`, not prose the client has to parse: room identity, the
  direction actually travelled, the ways out, inventory deltas, a mood hue, and
  whether the story has ended.
- **The chart.** Rooms are placed on a grid by accumulating movement vectors,
  with a spiral search for a free cell when geography folds back on itself.
  Dashed stubs mark exits you've seen but not taken.
- **The mood drives the palette.** The model returns an HSL hue for each scene
  and the entire UI is derived from it through one CSS custom property, which
  animates between scenes via `@property`.
- **Continuity.** A compact index of every room already named is appended to each
  request, so ids stay stable even after older turns fall out of the context
  window.

## Model selection

Model ids get retired, so nothing is hard-coded. On first call the server hits
`ListModels`, keeps the ones that support `generateContent`, scores them
(preferring `-latest` aliases, then Flash, then higher version numbers, docking
previews), and uses the winner. The chosen id is shown in the top-right of the
page. Pin a specific one with `GEMINI_MODEL` in `.env` if you'd rather.

## Layout

```
server.mjs        zero-dependency server: static files, key handling,
                  model discovery, the /api/turn proxy and the prompt
public/index.html
public/style.css  one hue variable, everything else derived
public/app.js     map model, canvas cartography, turn loop, key flow
```

## Endpoints

| | |
|---|---|
| `GET /api/status` | whether a key is loaded, where from, masked hint, chosen model |
| `POST /api/key` | `{key, remember}` — verifies before accepting, persists only on success |
| `POST /api/key/forget` | drops it from memory and removes it from `.env` |
| `POST /api/turn` | `{seed, history, action}` → one validated turn |
