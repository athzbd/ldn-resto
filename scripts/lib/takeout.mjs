/* Reading a Google Takeout "Saved" export.
 *
 * Takeout gives one CSV per Maps list ("Want to go.csv", "Favourite
 * places.csv", one per custom list) with columns Title, Note, URL and, in
 * newer exports, Tags and Comment. Starred places come separately as
 * "Saved Places.json" (GeoJSON) — that one does carry a date.
 *
 * The URL is the important part: it holds Google's own id for the exact place
 * you saved, so the resolver can confirm it found that branch and not a
 * same-named one across town. */

/** RFC 4180 CSV, including quoted fields with commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Pull Google's identifiers out of a saved-place URL. */
export function idsFromUrl(url = '') {
  const out = { placeId: null, cid: null };

  const pid = url.match(/(?:query_place_id=|place_id:)([A-Za-z0-9_-]{10,})/);
  if (pid) out.placeId = pid[1];

  // .../data=!4m2!3m1!1s0x48761b...:0x6a8f... — the second half is the CID.
  const fid = url.match(/!1s0x[0-9a-f]+:(0x[0-9a-f]+)/i);
  if (fid) out.cid = BigInt(fid[1]).toString();

  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid) out.cid = cid[1];

  return out;
}

/** The place name embedded in /maps/place/<name>/ when Title is blank. */
export function nameFromUrl(url = '') {
  const m = url.match(/\/maps\/place\/([^/@?]+)/);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
}

export const kebab = (s) => s
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* Maps' built-in lists have fixed meanings on the page; anything else is one
   of your own lists and keeps its name. */
const BUILT_IN = [
  [/^(favou?rites?|favou?rite places)$/i, 'favourites', 'Favourites'],
  [/^want to go$/i, 'want-to-go', 'Want to go'],
  [/^starred( places)?$|^saved places$/i, 'starred', 'Starred'],
  [/^travel plans$/i, 'travel-plans', 'Travel plans'],
];

export function listFromFilename(base) {
  for (const [re, id, label] of BUILT_IN) if (re.test(base)) return { id, label };
  return { id: kebab(base), label: base };
}

/** A date column, if this export happens to have one. */
export function dateFrom(row) {
  const key = Object.keys(row).find((k) => /date|added|created|saved/.test(k));
  const d = key && row[key] ? new Date(row[key]) : null;
  return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null;
}
