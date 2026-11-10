#!/usr/bin/env node
/* Link every unresolved entry to its Google place.
 *
 * Your Takeout URL carries Google's id for the exact place you saved, so this
 * does not have to guess: it searches by name and keeps only the result whose
 * CID matches yours. If the London-biased search misses (a place saved on
 * holiday), it retries unbiased. Only entries with no saved id at all fall
 * back to "top search result", and those are marked `matchedBy: "name-only"`.
 *
 * Then: confirmed permanent closures are deleted, and anything outside Greater
 * London moves to `elsewhere` (kept, not shown).
 *
 * Usage:  GOOGLE_MAPS_API_KEY=xxx node scripts/resolve-places.mjs [--dry-run]
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  requireKey, placeDetails, textSearch, cidOf, applyResult, sweep, sleep, writeOutputs,
} from './lib/google.mjs';

const DATA_PATH = new URL('../data/places.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
requireKey();

const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const unmatched = [];
let resolved = 0;

async function find(place) {
  const { placeId, cid } = place.source || {};

  if (placeId) {
    const r = await placeDetails(placeId);
    return r.gone ? null : { result: r, matchedBy: 'saved-id' };
  }

  const query = place.searchQuery || place.name;
  for (const biasLondon of [true, false]) {
    const results = await textSearch(biasLondon ? `${query} London` : query, { biasLondon });
    if (!cid) return results[0] ? { result: results[0], matchedBy: 'name-only' } : null;
    const hit = results.find((r) => cidOf(r) === cid);
    if (hit) return { result: hit, matchedBy: 'cid' };
    await sleep(150);
  }
  return null;
}

for (const place of data.places) {
  if (place.google?.placeId) continue;

  try {
    const match = await find(place);
    if (!match) {
      unmatched.push(place.name);
      console.log(`✗ ${place.name} — no match${place.source?.cid ? ' for the saved CID' : ''}`);
      continue;
    }
    applyResult(place, match.result, today, { google: { matchedBy: match.matchedBy } });
    resolved++;
    const flag = match.result.businessStatus === 'CLOSED_PERMANENTLY' ? '  ⚠️ CLOSED' : '';
    const how = match.matchedBy === 'name-only' ? '  (name only — check this one)' : '';
    console.log(`✓ ${place.name}${flag}${how}\n    → ${match.result.displayName?.text} · ${match.result.formattedAddress}`);
  } catch (err) {
    unmatched.push(place.name);
    console.log(`✗ ${place.name} — ${err.message}`);
  }
  await sleep(150);
}

const swept = sweep(data, today);

console.log(`\nResolved ${resolved}.`);
if (swept.removed.length) console.log(`Deleted as permanently closed (${swept.removed.length}):\n  ${swept.removed.join('\n  ')}`);
if (swept.flagged.length) console.log(`Google says closed, but the match is name-only, so kept and flagged:\n  ${swept.flagged.join('\n  ')}`);
if (swept.moved.length) console.log(`Outside London, moved to "elsewhere" (${swept.moved.length}):\n  ${swept.moved.join('\n  ')}`);
if (unmatched.length) console.log(`No match — give these a "searchQuery":\n  ${unmatched.join('\n  ')}`);

await writeOutputs({
  removed: swept.removed.join('\n'),
  removed_count: swept.removed.length,
  summary: `Resolved ${resolved}; removed ${swept.removed.length} closed; moved ${swept.moved.length} outside London; ${unmatched.length} unmatched.`,
});

if (DRY_RUN) console.log('--dry-run: no files written.');
else await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
