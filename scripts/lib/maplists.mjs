/* Reading a shared Google Maps list.
 *
 * UNOFFICIAL. Google has no API for saved lists. A list shared as "anyone with
 * the link" is fetched by the Maps web page from an internal endpoint, and this
 * reads that same response. Google can change its shape at any time, so the
 * parser below looks for the data by shape rather than by fixed positions, and
 * sync-lists.mjs refuses to delete anything when a list comes back empty or
 * unreadable. If it breaks, run the sync workflow with "debug" on and the raw
 * shape is printed to the log. */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  // Skips the EU cookie-consent interstitial, which would otherwise be served
  // instead of the list.
  Cookie: 'SOCS=CAI; CONSENT=YES+',
};

/** The list id from a share link (maps.app.goo.gl/…) or a full list URL. */
export async function listIdFrom(url, hops = 0) {
  const direct = url.match(/placelists\/list\/([A-Za-z0-9_-]+)/);
  if (direct) return direct[1];
  if (hops > 6) throw new Error(`too many redirects from ${url}`);

  const res = await fetch(url, { redirect: 'manual', headers: HEADERS });
  const next = res.headers.get('location');
  if (next) return listIdFrom(new URL(next, url).href, hops + 1);

  const body = await res.text();
  const inBody = body.match(/placelists\/list\/([A-Za-z0-9_-]+)/);
  if (inBody) return inBody[1];
  throw new Error(`no list id found behind ${url} (HTTP ${res.status}) — is the list shared?`);
}

export async function fetchListJson(listId) {
  const url = 'https://www.google.com/maps/preview/entitylist/getlist'
    + `?authuser=0&hl=en&gl=gb&pb=!1m4!1s${encodeURIComponent(listId)}!2e1!3m1!1e1!2e2!3e2!4i500!16b1`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} reading list ${listId}`);
  try {
    return JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  } catch {
    throw new Error(`list ${listId} did not return JSON (starts: ${text.slice(0, 80)})`);
  }
}

/* ---------- shape-based extraction ---------- */

const isLat = (n) => typeof n === 'number' && n >= -90 && n <= 90;
const isLng = (n) => typeof n === 'number' && n >= -180 && n <= 180;

/** First [.., .., lat, lng] pair found anywhere inside `node`. */
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

const looksLikeItem = (e) => Array.isArray(e) && typeof e[2] === 'string' && e[2].trim() && findCoords(e[1] ?? e);

/** The longest array whose members look like saved places. */
function findItems(node, depth = 0, best = []) {
  if (!Array.isArray(node) || depth > 6) return best;
  const hits = node.filter(looksLikeItem);
  if (hits.length > best.length && hits.length >= node.length * 0.8) best = hits;
  for (const child of node) best = findItems(child, depth + 1, best);
  return best;
}

/** First non-empty string at index 4 of the top-level metadata (the list name). */
function findListName(json) {
  const meta = Array.isArray(json?.[0]) ? json[0] : json;
  return typeof meta?.[4] === 'string' && meta[4].trim() ? meta[4].trim() : null;
}

/**
 * Parse a getlist response into {name, places:[{name, note, lat, lng, cid, added}]}.
 */
export function parseList(json) {
  const items = findItems(json);
  const places = items.map((e) => {
    const raw = JSON.stringify(e);
    const fid = raw.match(/0x[0-9a-f]{6,}:(0x[0-9a-f]+)/i);
    const coords = findCoords(e[1] ?? e);
    return {
      name: e[2].trim(),
      note: typeof e[3] === 'string' ? e[3].trim() : '',
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      cid: fid ? BigInt(fid[1]).toString() : null,
      added: findTimestamp(e),
    };
  });
  return { name: findListName(json), places };
}
