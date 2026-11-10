# LDN Resto

Static site listing Athena's London food and drink places. Sister project of
kl-recs, same shape: no build step, no framework, no backend. Hosted on GitHub
Pages at https://athzbd.github.io/ldn-resto/

Source of the list: her Google Maps saved lists, shared as "anyone with the
link". `scripts/sync-lists.mjs` reads them daily (unofficial — Google has no
API for lists). Google Takeout + `import-takeout.mjs` is the fallback.

## Layout

- `data/places.json` — the single source of truth
  - `places` — shown on the page
  - `elsewhere` — saves outside Greater London; kept, never shown
  - `removed` — ids of places deleted as permanently closed, so a re-import
    cannot bring them back
  - `lists` — her Maps lists (`favourites`, `want-to-go`, custom ones), each
    with the share `url` the sync reads
  - `categories` — chips; each maps to Google place `types`
- `index.html`, `assets/app.js`, `assets/styles.css` — the page
- `assets/config.js` — Maps browser key placeholder, substituted on deploy
- `scripts/sync-lists.mjs` — daily mirror of the shared lists
- `scripts/lib/maplists.mjs` — reads a shared list; shape-based, unofficial
- `scripts/import-takeout.mjs` — fallback: merges a Takeout export
- `scripts/resolve-places.mjs` — links new entries to Google places
- `scripts/check-places.mjs` — status + opening hours; `--new-only` for imports
- `scripts/lib/areas.mjs` — coordinates → general area ("Covent Garden")
- `.github/workflows/` — daily sync; deploy on push; resolve on data push;
  monthly hours/closure check

## Rules that matter

**Never invent her opinions.** `notes`, `tags`, `lists` and `categories` come
from her. `lists` and `notes` follow Google Maps (the sync overwrites them);
`tags` and `categories` are edited here. If something has no note, leave
it empty. There is no rating field. "Favourite" means it is on her Maps
Favourites list — never infer it.

**Google's facts stay in `google`.** Scripts write only inside a place's
`google` block, plus `area` when it is null. Category chips are derived on the
page from `google.types` (a fact about the venue) unioned with her own
`categories`; scripts never write `categories`.

**The sync must never delete on a bad read.** A list that fails or comes back
empty is skipped entirely. Keep that guard if you change `maplists.mjs`.

**Closures.** A permanently closed place is deleted only when the match is
verified (`google.matchedBy` is `saved-id` or `cid` — the result's CID equals
the one in her saved Maps URL). A `name-only` match is flagged, not deleted.
She asked for closed places to be deleted rather than archived.

**Area means general area.** "Covent Garden", not a station. `areas.mjs` is a
nearest-centre lookup; fix a wrong one by editing `area` in the JSON (scripts
never overwrite a non-null area) or by adding/moving a centre.

**No build step.** Don't introduce npm, bundlers, or a framework without asking.

**Two Google keys, different exposure.** `GOOGLE_MAPS_API_KEY` (server, Places
API) stays in Actions secrets and must never reach the browser.
`GOOGLE_MAPS_BROWSER_KEY` is injected into `assets/config.js` at deploy time.

**Field masks cost money.** `check-places.mjs` asks for `regularOpeningHours`
because the day/time filter needs it; that is Place Details Enterprise
(~1,000 free calls a month). Don't add rating, reviews, photos or price.
`resolve-places.mjs` stays at Pro fields.

## Adding a place

She should save it in Google Maps; the sync picks it up. To add a list, put its
share link in `lists[].url`. A place added by hand here (with `lists: []`) is
never touched by the sync.

## Checking work

```bash
node --check assets/app.js
node -e "JSON.parse(require('fs').readFileSync('data/places.json','utf8'))"
node scripts/serve.mjs   # then open http://localhost:8000
```

The map cannot be verified locally — there is no browser key outside deploys.
