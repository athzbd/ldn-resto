/* Reading a shared Google Maps list.
 *
 * UNOFFICIAL. Google has no API for saved lists. A list shared as "anyone with
 * the link" is fetched by the Maps web page from an internal endpoint, and this
 * reads that same response. Google can change its shape at any time, so the
 * parser reads the known positions first and falls back to looking for the
 * data by shape, and sync-lists.mjs refuses to delete anything when a list
 * comes back empty, unreadable or incomplete. If it breaks, run the sync
 * workflow with "debug" on and the raw shape is printed to the log.
 *
 * Response shape, as checked against real lists on 2026-11-10:
 *   )]}'
 *   [[ [listId, …], 4, [.., .., "https://www.google.com/maps/placelists/list/<id>"],
 *      [owner…], "List name", "description", null, null,
 *      [ item, item, … ],          // [0][8]  the saved places
 *      …, 191 ],                   // [0][12] how many places the list has
 *    …]
 *   item = [null,
 *           [null, null, "Name, address", null, "address",
 *            [null, null, lat, lng],
 *            ["<signed int64>", "<signed int64>"],   // feature id halves; 2nd = CID
 *            "/g/…"],
 *           "Name", "Your note", null, null, null, [],
 *           [[1], [<same ids>]],
 *           [savedSeconds, nanos], [updatedSeconds, nanos], null, [owner…]]
 *
 * A share link (maps.app.goo.gl/…) redirects to
 *   https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2s<listId>!3e1
 * (or !3e2), not to /placelists/list/<id>; both forms are accepted. */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  // Skips the EU cookie-consent interstitial, which would otherwise be served
  // instead of the list.
  Cookie: 'SOCS=CAI; CONSENT=YES+',
};

/* !4i is the page size. 500 truncates big lists (Want to go has 1,200+), and
   a truncated list would look like hundreds of unsaves, so ask for everything
   and check the count against the total Google reports. */
const PAGE_SIZE = 5000;

const LIST_ID_PATTERNS = [
  /placelists\/list\/([A-Za-z0-9_-]{10,})/,
  /!11m\d+!2s([A-Za-z0-9_-]{10,})/,
  /!2s([A-Za-z0-9_-]{20,})!3e\d/,
];

/* Undo the escaping a link picks up inside an HTML page or a script string:
   %21, !, \x21, &#33;, \/ and friends. */
function unescapeAll(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function listIdIn(text) {
  for (const t of [text, unescapeAll(text), unescapeAll(unescapeAll(text))]) {
    for (const re of LIST_ID_PATTERNS) {
      const m = t.match(re);
      if (m) return m[1];
    }
  }
  return null;
}

/** The list id from a share link (maps.app.goo.gl/…) or a full list URL. */
export async function listIdFrom(url, hops = 0) {
  const direct = listIdIn(url);
  if (direct) return direct;
  if (hops > 6) throw new Error(`too many redirects from ${url}`);

  // A consent page carries the real destination in ?continue=.
  const cont = (() => { try { return new URL(url).searchParams.get('continue'); } catch { return null; } })();
  if (cont) return listIdFrom(cont, hops + 1);

  const res = await fetch(url, { redirect: 'manual', headers: HEADERS });
  const next = res.headers.get('location');
  if (next) return listIdFrom(new URL(next, url).href, hops + 1);

  const body = await res.text();
  const inBody = listIdIn(body);
  if (inBody) return inBody;

  // Some short links answer 200 with a page that redirects by script or meta
  // refresh; follow any Maps URL it names.
  const onward = unescapeAll(body).match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'<>\s]*/);
  if (onward && onward[0] !== url) return listIdFrom(onward[0], hops + 1);

  if (process.argv.includes('--debug')) {
    console.log(`--- body behind ${url} (HTTP ${res.status}) ---\n${body.slice(0, 1500)}`);
  }
  throw new Error(`no list id found behind ${url} (HTTP ${res.status}) — is the list shared?`);
}

export async function fetchListJson(listId) {
  const url = 'https://www.google.com/maps/preview/entitylist/getlist'
    + `?authuser=0&hl=en&gl=gb&pb=!1m4!1s${encodeURIComponent(listId)}!2e1!3m1!1e1!2e2!3e2!4i${PAGE_SIZE}!16b1`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} reading list ${listId}`);
  try {
    return JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  } catch {
    throw new Error(`list ${listId} did not return JSON (starts: ${text.slice(0, 80)})`);
  }
}

/* ---------- extraction ---------- */

const isLat = (n) => typeof n === 'number' && n >= -90 && n <= 90;
const isLng = (n) => typeof n === 'number' && n >= -180 && n <= 180;

/** First [null, null, lat, lng] found anywhere inside `node`. */
function findCoords(node, depth = 0) {
  if (!Array.isArray(node) || depth > 8) return null;
  if (node.length >= 4 && node[0] == null && node[1] == null
      && isLat(node[2]) && isLng(node[3]) && !(Number.isInteger(node[2]) && Number.isInteger(node[3]))) {
    return { lat: node[2], lng: node[3] };
  }
  for (const child of node) {
    const hit = findCoords(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** First [seconds, nanos] timestamp — when the place was added to the list. */
function findTimestamp(node, depth = 0) {
  if (!Array.isArray(node) || depth > 6) return null;
  const now = Date.now() / 1000;
  if (node.length === 2 && Number.isInteger(node[0]) && node[0] > 1.2e9 && node[0] <= now
      && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < 1e9) {
    return new Date(node[0] * 1000).toISOString().slice(0, 10);
  }
  for (const child of node) {
    const hit = findTimestamp(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const isIntString = (s) => typeof s === 'string' && /^-?\d{5,20}$/.test(s);

/** Google's CID as an unsigned decimal string — the form in ?cid= links. */
function cidOf(item) {
  // Known spot: the feature id halves, signed int64 as decimal strings.
  const pair = [item?.[1]?.[6], item?.[8]?.[1]].find((p) => Array.isArray(p) && isIntString(p[1]));
  if (pair) return BigInt.asUintN(64, BigInt(pair[1])).toString();
  // Older / other shape: "0x…:0x…".
  const fid = JSON.stringify(item).match(/0x[0-9a-f]{6,}:(0x[0-9a-f]+)/i);
  return fid ? BigInt(fid[1]).toString() : null;
}

/** A saved-place entry: coordinates in [1], name (possibly empty) at [2]. */
const looksLikeItem = (e) => Array.isArray(e) && typeof e[2] === 'string' && findCoords(e[1] ?? e);

/** The longest array whose members look like saved places (fallback). */
function findItems(node, depth = 0, best = []) {
  if (!Array.isArray(node) || depth > 6) return best;
  const hits = node.filter(looksLikeItem);
  if (hits.length > best.length && hits.length >= node.length * 0.8) best = hits;
  for (const child of node) best = findItems(child, depth + 1, best);
  return best;
}

function itemsOf(json) {
  const known = json?.[0]?.[8];
  if (Array.isArray(known) && known.length && known.every(looksLikeItem)) return known;
  return findItems(json);
}

function listNameOf(json) {
  const meta = Array.isArray(json?.[0]) ? json[0] : json;
  return typeof meta?.[4] === 'string' && meta[4].trim() ? meta[4].trim() : null;
}

/** How many places Google says the list holds, if it says. */
function totalOf(json) {
  const n = json?.[0]?.[12];
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Parse a getlist response into
 *   {name, total, unnamed, places:[{name, note, lat, lng, cid, added}]}.
 * `unnamed` counts saves with no name (dropped pins); they are left out.
 */
export function parseList(json) {
  const items = itemsOf(json);
  let unnamed = 0;
  const places = [];
  for (const e of items) {
    const name = e[2].trim();
    if (!name) { unnamed++; continue; }
    const coords = findCoords(e[1] ?? e);
    places.push({
      name,
      note: typeof e[3] === 'string' ? e[3].trim() : '',
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      cid: cidOf(e),
      added: findTimestamp(e.slice(9)) ?? findTimestamp(e),
    });
  }
  return { name: listNameOf(json), total: totalOf(json), unnamed, read: items.length, places };
}
