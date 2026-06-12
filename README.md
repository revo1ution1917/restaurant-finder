# 🍽 Restaurant Finder

A mobile web app over your Google Maps saved list. You keep adding/removing
pins in Google Maps; a scheduled GitHub Action re-syncs the data — no laptop
needed. Filter by cuisine, area, price, rating, and your own tags, or type a
description like *"date night in Hackney, no Mexican, under £100,
unpretentious"*.

## How it works

```
Google Maps list (you edit as usual)
        │  shared list link (unofficial parse)
        ▼
GitHub Action (every 6h + manual)  ──►  Places API enrichment (new places only)
        │
        ▼
data.json in this repo  ──►  GitHub Pages app (your phone)
                        └──►  Claude Project (see claude-project.md)
```

## One-time setup (~10 min)

1. **Create the repo.** New GitHub repo (e.g. `restaurant-finder`), public.
   Copy this folder's contents in (GitHub Desktop: add existing folder →
   publish). Make sure the hidden `.github` folder comes along.

2. **Add secrets.** Repo → Settings → Secrets and variables → Actions →
   "New repository secret":
   - `LIST_URL` — your shared Google Maps list link (Maps → Saved → your
     list → Share → anyone with link).
   - `GOOGLE_API_KEY` — your Places API (New) key.

3. **Enable Pages.** Repo → Settings → Pages → Source: "Deploy from a
   branch" → `main` / root. Your app will be at
   `https://<username>.github.io/restaurant-finder/`.

4. **First sync.** Repo → Actions tab → "Sync Google Maps list" → "Run
   workflow". Takes a couple of minutes the first time (it enriches every
   place); later runs only enrich new places.

5. **Phone:** open the app URL in Safari/Chrome → Share → "Add to Home
   Screen". Done.

6. **Optional — Claude as concierge:** see `claude-project.md`.

## Tagging vibes

The app reads your **notes in Google Maps** as tags. In Google Maps, open the
list, tap a place → add/edit its note with comma-separated words, e.g.
`date night, unpretentious, natural wine`. Next sync, they appear as
filterable tags and feed the text search.

## Manual overrides

If Google gets a cuisine wrong (or you want to force a value), create
`overlay.json` in the repo root:

```json
{
  "0x47d8...:0x9e2...": { "cuisine": "Korean", "tags": ["bbq", "groups"] }
}
```

Keys are place ids from `data.json`; fields overwrite synced values.

## When sync breaks

The shared-list page format is unofficial. If Google changes it, the Action
fails loudly (you'll get a GitHub email) rather than corrupting data. The
parser lives in `sync/sync.mjs` — paste the failure log into Claude and ask
it to fix the parser.

## Costs

£0 hosting (GitHub Pages + Actions free tier). Places API: one-time
enrichment of ~300 places ≈ a few pounds of Google's **free monthly credit**;
after that only newly added places are looked up (~pennies/month).

## Privacy notes

- The repo (and `data.json`) is public: restaurant names, your notes/tags
  are visible to anyone who finds the URL. Don't put private info in notes.
- The share link itself stays in a GitHub secret (not in the repo).
