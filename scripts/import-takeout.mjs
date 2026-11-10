#!/usr/bin/env node
/* Merge a Google Takeout "Saved" export into data/places.json.
 *
 * Point it at the unzipped Takeout folder (or straight at the CSVs):
 *
 *   node scripts/import-takeout.mjs ~/Downloads/Takeout [--dry-run]
 *
 * Safe to re-run with a fresh export whenever you have saved more places:
 *   - new places are appended with today's date as `added`, which is what
 *     drives "Recently added" (Takeout lists carry no save date, so the very
 *     first import is undated and ordered by its position in the export)
 *   - existing places gain any list they have joined; your notes, tags and
 *     categories in places.json are never overwritten
 *   - anything previously removed as closed, or set aside as outside London,
 *     stays out
 *
 * No network calls. Run resolve-places.mjs (or the Resolve workflow) after. */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import {
  parseCsv, idsFromUrl, nameFromUrl, kebab, listFromFilename, dateFrom,
} from './lib/takeout.mjs';

const DATA_PATH = new URL('../data/places.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const today = new Date().toISOString().slice(0, 10);

if (!inputs.length) {
  console.error('Usage: node scripts/import-takeout.mjs <Takeout folder or CSV files> [--dry-run]');
  process.exit(1);
}

async function collect(path, out = []) {
  const s = await stat(path);
  if (s.isDirectory()) {
    for (const name of await readdir(path)) await collect(join(path, name), out);
  } else if (/\.csv$/i.test(path) || /saved places\.json$/i.test(path)) {
    out.push(path);
  }
  return out;
}

/** Every saved row in the export as {name, note, tags, url, ids, list, date, order}. */
async function readExport(files) {
  const rows = [];
  for (const file of files) {
    const base = basename(file, extname(file));
    const text = await readFile(file, 'utf8');

    if (/\.json$/i.test(file)) {
      const list = listFromFilename('Starred places');
      const features = JSON.parse(text).features || [];
      features.forEach((f, order) => {
        const p = f.properties || {};
        const url = p.google_maps_url || p['Google Maps URL'] || '';
        const loc = p.location || p.Location || {};
        rows.push({
          name: loc.name || loc['Business Name'] || p.Title || nameFromUrl(url),
          note: p.Comment || '',
          tags: [],
          url,
          ids: idsFromUrl(url),
          list,
          date: dateFrom({ date: p.date || p.Published || '' }),
          order,
        });
      });
      continue;
    }

    const list = listFromFilename(base);
    parseCsv(text).forEach((r, order) => {
      const url = r.url || '';
      const name = r.title || nameFromUrl(url);
      if (!name) return;
      rows.push({
        name,
        note: [r.note, r.comment].filter(Boolean).join(' — '),
        tags: (r.tags || '').split(/[,;]/).map((t) => kebab(t)).filter(Boolean),
        url,
        ids: idsFromUrl(url),
        list,
        date: dateFrom(r),
        order,
      });
    });
  }
  return rows;
}

const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
data.places ||= [];
data.elsewhere ||= [];
data.removed ||= [];
data.lists ||= [];

const files = (await Promise.all(inputs.map((p) => collect(p)))).flat();
if (!files.length) {
  console.error('No list CSVs found. In the Takeout zip they live under Takeout/Saved/.');
  process.exit(1);
}
console.log(`Reading ${files.length} file(s):\n  ${files.map((f) => basename(f)).join('\n  ')}\n`);

const rows = await readExport(files);
const firstImport = data.places.length === 0 && data.elsewhere.length === 0;

/* One lookup across everything we already know about, so a place saved to
   two lists becomes one entry with two lists. */
const keysOf = (p) => [
  p.source?.cid && `cid:${p.source.cid}`,
  p.source?.placeId && `pid:${p.source.placeId}`,
  p.google?.placeId && `pid:${p.google.placeId}`,
  !p.source?.cid && !p.source?.placeId && `name:${p.name.toLowerCase()}`,
].filter(Boolean);

const index = new Map();
for (const p of [...data.places, ...data.elsewhere]) keysOf(p).forEach((k) => index.set(k, p));

const gone = new Set(data.removed.flatMap((r) => [
  r.cid && `cid:${r.cid}`, r.placeId && `pid:${r.placeId}`,
]).filter(Boolean));

const usedIds = new Set([...data.places, ...data.elsewhere].map((p) => p.id));
const uniqueId = (name) => {
  const base = kebab(name) || 'place';
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
  usedIds.add(id);
  return id;
};

let added = 0;
let joined = 0;
let skippedClosed = 0;
const seen = new Set();

for (const row of rows) {
  const rowKeys = [
    row.ids.cid && `cid:${row.ids.cid}`,
    row.ids.placeId && `pid:${row.ids.placeId}`,
    !row.ids.cid && !row.ids.placeId && `name:${row.name.toLowerCase()}`,
  ].filter(Boolean);

  if (rowKeys.some((k) => gone.has(k))) { skippedClosed++; continue; }

  if (!data.lists.some((l) => l.id === row.list.id)) data.lists.push(row.list);

  let place = rowKeys.map((k) => index.get(k)).find(Boolean);
  if (place) {
    seen.add(place);
    if (!place.lists.includes(row.list.id)) {
      place.lists.push(row.list.id);
      place.updated = today;
      joined++;
    }
    // Fill gaps only. Anything you have written in places.json wins.
    if (!place.notes && row.note) { place.notes = row.note; place.updated = today; }
    for (const t of row.tags) if (!place.tags.includes(t)) place.tags.push(t);
    if (row.order < (place.source.order ?? Infinity)) place.source.order = row.order;
    continue;
  }

  place = {
    id: uniqueId(row.name),
    name: row.name,
    lists: [row.list.id],
    categories: [],
    area: null,
    notes: row.note,
    tags: row.tags,
    added: row.date || (firstImport ? null : today),
    updated: today,
    source: { url: row.url, cid: row.ids.cid, placeId: row.ids.placeId, order: row.order },
    google: { placeId: null },
  };
  data.places.push(place);
  rowKeys.forEach((k) => index.set(k, place));
  seen.add(place);
  added++;
}

const missing = data.places.filter((p) => !seen.has(p));

console.log(`New places:            ${added}`);
console.log(`Joined another list:   ${joined}`);
if (skippedClosed) console.log(`Skipped (removed as closed earlier): ${skippedClosed}`);
console.log(`Lists: ${data.lists.map((l) => l.label).join(', ')}`);
if (firstImport) {
  console.log('\nFirst import: Takeout has no save dates, so these are left undated and');
  console.log('"Recently added" orders them by their position in the export.');
}
if (missing.length) {
  console.log(`\nIn places.json but not in this export (left alone — delete by hand if you unsaved them):`);
  missing.forEach((p) => console.log(`  - ${p.name}`));
}

if (DRY_RUN) {
  console.log('\n--dry-run: no files written.');
} else {
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log('\nWrote data/places.json. Next: run the "Resolve places" workflow.');
}
