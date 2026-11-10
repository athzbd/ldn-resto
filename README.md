# LDN Resto

Athena's London food and drink places — searchable, filterable and shareable,
kept in step with her Google Maps saved lists. Static site, no backend, GitHub
Pages.

**Live site:** https://athzbd.github.io/ldn-resto/

## What it does

- **Search and filter** by category (coffee, brunch, pubs, Japanese…), general
  area, and which Maps list a place is on (❤️ Favourites, 📌 Want to go, your
  own lists).
- **"Saturday, coffee, 15 minutes from me"** — pick a day and/or a time to see
  what is open then (London time), and a walking radius from where you are.
- **🎲 Surprise me** picks one at random from whatever the filters show.
- **Newest first** — places sort by when you saved them in Maps, with a *New*
  badge for the last 30 days.
- **Share** — the filters live in the URL, so "coffee in Shoreditch, open
  Saturday" is a link you can send. Your location is never in the link.
- **Permanently closed places are deleted** when Google confirms it about the
  exact place you saved.

## How it stays in sync with Google Maps

You keep saving places in Google Maps as normal. Once a day the **Sync from
Google Maps** workflow reads your shared lists and updates the site:

- new saves appear, dated the day you saved them
- moving a place between lists (Want to go → Favourites) is followed
- a note you write on a place in Maps shows on its card
- unsaving a place removes it
- anything outside London is kept aside, not shown

To add a list: in Google Maps open **You → Saved**, open the list, tap
**Share**, make it viewable by anyone with the link, and put the link in
`data/places.json` under `lists` (or give it to Claude):

```json
{ "id": "favourites", "label": "Favourites", "url": "https://maps.app.goo.gl/…" }
```

Run it now from **Actions → Sync from Google Maps → Run workflow**.

**This is unofficial.** Google has no API for saved lists; the sync reads the
same data the Maps web page loads for a shared list. If Google changes that,
the sync stops adding things — it never deletes anything from a list it could
not read — and opens an issue saying so. `scripts/import-takeout.mjs` is the
fallback: a Google Takeout export of **Saved** imports the same way.

## Data model

```json
{
  "id": "prufrock-coffee",
  "name": "Prufrock Coffee",
  "lists": ["favourites"],
  "categories": [],
  "area": "Clerkenwell",
  "notes": "",
  "tags": [],
  "added": "2025-03-01",
  "source": { "cid": "…", "order": 3 },
  "google": {
    "placeId": "ChIJ…", "lat": 51.52, "lng": -0.11,
    "businessStatus": "OPERATIONAL", "types": ["coffee_shop", "cafe"],
    "hours": [[1, 480, 1, 1020]], "matchedBy": "cid", "lastChecked": "2026-11-10"
  }
}
```

`name`, `lists` and `notes` follow Google Maps. `categories` and `tags` are
yours to add here. Everything in `google` belongs to the scripts. Category
chips come from Google's place type plus any `categories` you add. `area` is
set once from the coordinates and never overwritten — fix a wrong one by hand.

## Google setup (optional, but needed for hours and closures)

Without a key the site still works from the lists alone: names, notes, areas,
map pins, walking distance. The key adds opening hours (the day/time filter)
and closed-place removal.

1. Repo **Settings → Secrets and variables → Actions**: add
   `GOOGLE_MAPS_API_KEY` (Places API (New)) and `GOOGLE_MAPS_BROWSER_KEY`
   (Maps JavaScript, HTTP-referrer restricted to `https://athzbd.github.io/*`,
   with a daily quota cap). The kl-recs keys work.
2. **Settings → Pages → Source: GitHub Actions.**

**Cost.** Linking a new place uses Text Search at the Pro tier (about 5,000
free calls a month). Opening hours are Place Details Enterprise (about 1,000
free a month): one call per new place, then once a month for everything. Up to
roughly a thousand places this stays free; check Google's current pricing page
before growing far past that.

## Running it locally

```bash
node scripts/serve.mjs
```

Then open http://localhost:8000. The map needs the deploy-time key, so it shows
a setup message locally.
