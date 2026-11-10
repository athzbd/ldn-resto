/* Places API (New) calls and the bookkeeping shared by the resolver and the
 * monthly check. Everything here writes only inside a place's `google` block,
 * plus `area` when it is still null. Name, notes, lists, tags and categories
 * are yours and are never read for anything but the search query. */

import { areaFor, postalTown, inLondon, LONDON_BOUNDS } from './areas.mjs';

export const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export function requireKey() {
  if (!API_KEY) {
    console.error('Missing GOOGLE_MAPS_API_KEY.');
    process.exit(1);
  }
}

/* Pro tier at most. googleMapsUri is what lets us prove a search result is the
   exact place you saved (it carries the same CID as your Takeout URL). */
const PRO_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'businessStatus',
  'googleMapsUri', 'types', 'primaryType', 'addressComponents',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, fieldMask, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export function placeDetails(placeId, fields = PRO_FIELDS) {
  return call(`https://places.googleapis.com/v1/places/${placeId}`, fields.join(','));
}

export async function textSearch(query, { biasLondon = true } = {}) {
  const b = LONDON_BOUNDS;
  const body = { textQuery: query, regionCode: 'GB', pageSize: 5 };
  if (biasLondon) {
    body.locationBias = {
      rectangle: {
        low: { latitude: b.south, longitude: b.west },
        high: { latitude: b.north, longitude: b.east },
      },
    };
  }
  const json = await call(
    'https://places.googleapis.com/v1/places:searchText',
    PRO_FIELDS.map((f) => `places.${f}`).join(','),
    body,
  );
  return json.places || [];
}

export const cidOf = (result) => result?.googleMapsUri?.match(/[?&]cid=(\d+)/)?.[1] ?? null;

/** Opening hours as [openDay, openMin, closeDay, closeMin] rows (day 0 = Sunday,
    minutes from midnight, London time). A null close means open around the clock. */
export function compactHours(regularOpeningHours) {
  const periods = regularOpeningHours?.periods;
  if (!periods?.length) return null;
  return periods.map(({ open, close }) => [
    open.day, (open.hour ?? 0) * 60 + (open.minute ?? 0),
    close ? close.day : null, close ? (close.hour ?? 0) * 60 + (close.minute ?? 0) : null,
  ]);
}

/** Write a Places result into the entry. */
export function applyResult(place, result, today, extra = {}) {
  const g = (place.google ||= {});
  g.placeId = result.id ?? g.placeId;
  g.lat = result.location?.latitude ?? g.lat ?? null;
  g.lng = result.location?.longitude ?? g.lng ?? null;
  g.businessStatus = result.businessStatus ?? g.businessStatus ?? null;
  g.address = result.formattedAddress ?? g.address ?? null;
  if (result.types) g.types = result.types;
  if (result.primaryType) g.primaryType = result.primaryType;
  if (result.googleMapsUri) g.mapsUri = result.googleMapsUri;
  if ('regularOpeningHours' in result || extra.hoursChecked) {
    g.hours = compactHours(result.regularOpeningHours);
    g.hoursText = result.regularOpeningHours?.weekdayDescriptions ?? null;
  }
  Object.assign(g, extra.google || {});
  g.lastChecked = today;

  if (!place.area && g.lat != null) {
    place.area = areaFor({ lat: g.lat, lng: g.lng }, postalTown(result.addressComponents));
  }
}

/* A closure is only acted on when we know the match is the place you saved —
   either Google gave us its id directly, or the search result's CID equals the
   one in your Takeout URL. A name-only match can be the wrong branch, so that
   one is flagged on the card and left for you. */
export const verified = (place) => ['saved-id', 'cid'].includes(place.google?.matchedBy);

/**
 * Remove confirmed closures and set aside anything outside London.
 * Returns {removed, flagged, moved} as name lists for the run summary.
 */
export function sweep(data, today) {
  data.removed ||= [];
  data.elsewhere ||= [];
  const out = { removed: [], flagged: [], moved: [] };

  data.places = data.places.filter((p) => {
    const g = p.google || {};

    if (g.businessStatus === 'CLOSED_PERMANENTLY') {
      if (verified(p)) {
        // Kept only as an id so a later Takeout import does not bring it back.
        data.removed.push({
          name: p.name, cid: p.source?.cid ?? null, placeId: g.placeId ?? null,
          reason: 'closed permanently', on: today,
        });
        out.removed.push(p.name);
        return false;
      }
      out.flagged.push(p.name);
    }

    if (g.lat != null && !inLondon({ lat: g.lat, lng: g.lng })) {
      data.elsewhere.push(p);
      out.moved.push(`${p.name} (${g.address ?? 'no address'})`);
      return false;
    }
    return true;
  });

  data.areas = [...new Set(data.places.map((p) => p.area).filter(Boolean))].sort();
  return out;
}

export function writeOutputs(entries) {
  if (!process.env.GITHUB_OUTPUT) return;
  return import('node:fs').then(({ appendFileSync }) => {
    for (const [k, v] of Object.entries(entries)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<__EOF__\n${v}\n__EOF__\n`);
    }
  });
}
