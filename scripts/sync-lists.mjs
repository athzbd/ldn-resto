#!/usr/bin/env node
/* Mirror your shared Google Maps lists into data/places.json.
 *
 * Every list in `lists` that has a `url` (its share link) is read. Then:
 *   - a place newly saved in Maps is added, dated the day Maps says you saved
 *     it (or today, if Maps does not say)
 *   - which lists a place is on follows Maps exactly, so moving something
 *     from Want to go to Favourites shows up here
 *   - a note you write in Maps replaces the note here; an empty Maps note
 *     leaves the existing one alone
 *   - a place you unsaved from every synced list is deleted
 *   - anything previously deleted as permanently closed stays out, even if it
 *     is still saved in Maps
 *
 * Safety: a list that fails to load or comes back empty is skipped entirely —
 * nothing on it is deleted that run.
 *
 * Usage:  node scripts/sync-lists.mjs [--dry-run] [--debug]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { listIdFrom, fetchListJson, parseList } from './lib/maplists.mjs';
import { kebab, listFromFilename } from './lib/takeout.mjs';
import { areaFor, inLondon } from './lib/areas.mjs';
import { writeOutputs } from './lib/google.mjs';

const DATA_PATH = new URL('../data/places.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');
const today = new Date().toISOString().slice(0, 10);

const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
data.places ||= [];
data.elsewhere ||= [];
data.removed ||= [];
data.lists ||= [];

const toSync = data.lists.filter((l) => l.url);
if (!toSync.length) {
  console.log('No list has a share link yet. Add "url" to entries in "lists".');
  process.exit(0);
}

/* ---------- read every list ---------- */

const fetched = [];
const failed = [];

for (const list of toSync) {
  try {
    const listId = await listIdFrom(list.url);
    const json = await fetchListJson(listId);
    const parsed = parseList(json);

    if (DEBUG) {
      console.log(`\n--- ${list.label || list.url} (${listId}) — raw shape ---`);
      console.log(JSON.stringify(json).slice(0, 3000));
      console.log('--- parsed (first 3) ---');
      console.log(JSON.stringify(parsed.places.slice(0, 3), null, 2));
    }

    if (!parsed.places.length) throw new Error('no places found in the response (shape changed, or the list is empty)');
    // A partial read would look like a wave of unsaves, so treat it as a failure.
    if (parsed.total != null && parsed.read < parsed.total) {
      throw new Error(`only ${parsed.read} of ${parsed.total} places came back — list skipped`);
    }
    if (parsed.unnamed) console.log(`  (${parsed.unnamed} unnamed save(s) on this list skipped — dropped pins have no name)`);
    if (!list.label && parsed.name) Object.assign(list, listFromFilename(parsed.name), { url: list.url });
    list.label ||= parsed.name || list.id;
    list.id ||= kebab(list.label);

    const located = parsed.places.filter((p) => p.lat != null).length;
    console.log(`✓ ${list.label}: ${parsed.places.length} places (${located} with coordinates, `
      + `${parsed.places.filter((p) => p.cid).length} with a Google id, `
      + `${parsed.places.filter((p) => p.added).length} dated)`);
    fetched.push({ list, places: parsed.places });
  } catch (err) {
    failed.push(`${list.label || list.url}: ${err.message}`);
    console.log(`✗ ${list.label || list.url} — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // one list at a time, gently
}

/* ---------- merge ---------- */

const firstSync = data.places.length === 0 && data.elsewhere.length === 0;
const near = (a, b) => a.lat != null && b.lat != null
  && Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lng - b.lng) < 0.0005;

const all = [...data.places, ...data.elsewhere];
const findExisting = (item) =>
  (item.cid && all.find((p) => p.source?.cid === item.cid))
  || all.find((p) => p.name.toLowerCase() === item.name.toLowerCase()
    && (!item.lat || !p.google?.lat || near(item, p.google)));

const removedCids = new Set(data.removed.map((r) => r.cid).filter(Boolean));
const usedIds = new Set(all.map((p) => p.id));
const uniqueId = (name) => {
  const base = kebab(name) || 'place';
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
  usedIds.add(id);
  return id;
};

const seen = new Map();   // place -> Set(list ids it is on right now)
const added = [];
let renoted = 0;
let stillSavedButClosed = 0;

for (const { list, places } of fetched) {
  places.forEach((item, order) => {
    if (item.cid && removedCids.has(item.cid)) { stillSavedButClosed++; return; }

    let place = findExisting(item);
    if (!place) {
      place = {
        id: uniqueId(item.name),
        name: item.name,
        lists: [],
        categories: [],
        area: null,
        notes: item.note,
        tags: [],
        added: item.added || (firstSync ? null : today),
        updated: today,
        source: { cid: item.cid, order },
        google: { placeId: null, lat: item.lat, lng: item.lng },
      };
      if (item.lat != null) place.area = areaFor(item);
      (item.lat == null || inLondon(item) ? data.places : data.elsewhere).push(place);
      all.push(place);
      added.push(place.name);
    } else {
      if (item.note && item.note !== place.notes) { place.notes = item.note; place.updated = today; renoted++; }
      if (!place.added && item.added) place.added = item.added;
      if (item.cid && !place.source?.cid) (place.source ||= {}).cid = item.cid;
    }

    if (!seen.has(place)) seen.set(place, new Set());
    seen.get(place).add(list.id);
  });
}

/* Lists follow Maps — but only for lists that loaded this run. */
const syncedIds = new Set(fetched.map((f) => f.list.id));
const unsaved = [];

const reconcile = (arr) => arr.filter((p) => {
  const before = p.lists || [];
  const kept = before.filter((l) => !syncedIds.has(l));
  const now = [...kept, ...(seen.get(p) || [])];
  const wasSynced = before.some((l) => syncedIds.has(l));

  if (!now.length && wasSynced) { unsaved.push(p.name); return false; }
  if (now.join() !== before.join()) { p.lists = now; p.updated = today; }
  return true;
});

data.places = reconcile(data.places);
data.elsewhere = reconcile(data.elsewhere);
data.areas = [...new Set(data.places.map((p) => p.area).filter(Boolean))].sort();

/* ---------- report ---------- */

console.log(`\nNew: ${added.length}${added.length ? `\n  ${added.join('\n  ')}` : ''}`);
console.log(`Unsaved in Maps, deleted: ${unsaved.length}${unsaved.length ? `\n  ${unsaved.join('\n  ')}` : ''}`);
if (renoted) console.log(`Notes updated from Maps: ${renoted}`);
if (stillSavedButClosed) console.log(`Still saved in Maps but deleted earlier as permanently closed: ${stillSavedButClosed}`);
if (failed.length) console.log(`\nLists that could not be read (nothing on them was deleted):\n  ${failed.join('\n  ')}`);

await writeOutputs({
  added: added.join('\n'),
  unsaved: unsaved.join('\n'),
  failed: failed.join('\n'),
  failed_count: failed.length,
});

if (DRY_RUN) console.log('\n--dry-run: no files written.');
else await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

// All lists failing almost certainly means Google changed something.
if (failed.length && !fetched.length) process.exit(1);
