#!/usr/bin/env node
/* Monthly refresh: status and opening hours for every linked place.
 *
 * Confirmed permanent closures are deleted (see sweep() in lib/google.mjs for
 * what "confirmed" means). The names go into the commit message, and the ids
 * into `removed` so a later Takeout import cannot bring them back.
 *
 * Usage:  GOOGLE_MAPS_API_KEY=xxx node scripts/check-places.mjs [--dry-run] [--new-only]
 *
 * --new-only checks just the places that have never had their hours fetched,
 * which is what the resolve workflow uses after an import so it does not pay
 * for the whole list again.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  requireKey, placeDetails, applyResult, sweep, sleep, writeOutputs,
} from './lib/google.mjs';

const DATA_PATH = new URL('../data/places.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const NEW_ONLY = process.argv.includes('--new-only');
requireKey();

/* COST: regularOpeningHours is what the "open on Saturday at 9am" filter needs,
   and it moves Place Details into the Enterprise tier. Google's free allowance
   for that tier is about 1,000 calls a month (check the current pricing page),
   so a monthly run stays free up to roughly a thousand places. Past that, run
   it less often rather than adding fields. Do not add rating, reviews, photos
   or price level: nothing on the page uses them and some cost more again. */
const FIELDS = [
  'id', 'businessStatus', 'location', 'formattedAddress',
  'types', 'primaryType', 'googleMapsUri', 'regularOpeningHours',
];

const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const problems = [];
let checked = 0;

for (const place of data.places) {
  const placeId = place.google?.placeId;
  if (!placeId) {
    problems.push(`${place.name} — not linked yet, skipped`);
    continue;
  }
  if (NEW_ONLY && 'hours' in place.google) continue;
  try {
    const result = await placeDetails(placeId, FIELDS);
    checked++;
    if (result.gone) {
      problems.push(`${place.name} — Google no longer knows this place id; null its google block and re-resolve`);
      place.google.lastChecked = today;
    } else {
      applyResult(place, result, today, { hoursChecked: true });
    }
  } catch (err) {
    problems.push(`${place.name} — lookup failed: ${err.message}`);
  }
  await sleep(120);
}

const swept = sweep(data, today);
console.log(JSON.stringify({ checked, ...swept, problems }, null, 2));

await writeOutputs({
  removed: swept.removed.join('\n'),
  removed_count: swept.removed.length,
  flagged: swept.flagged.join('\n'),
  flagged_count: swept.flagged.length,
});

if (DRY_RUN) console.log('\n--dry-run: no files written.');
else await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
