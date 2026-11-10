/* LDN Resto — static list + Google map with client-side filtering.
   Data comes from data/places.json. No build step, no backend. */

const state = {
  data: null,
  categories: new Set(),
  area: '',
  list: '',
  search: '',
  day: '',          // '' | 'today' | '0'..'6' (0 = Sunday)
  time: '',         // '' | 'now' | minutes from midnight as a string
  walk: '',         // '' | max minutes on foot
  sort: 'recent',   // 'recent' | 'name' | 'near'
  origin: null,     // {lat, lng} once geolocation resolves
  view: 'list',
  recentPicks: [],
};

let map = null;
let infoWindow = null;
let markers = [];
let clusterer = null;
let mapsReady = null;   // promise, created on first map view

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.sin(dLng / 2) ** 2 * Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Straight-line distance undersells a walk through London streets by roughly
   a third; 5 km/h is an unhurried pace. Close enough to answer "is it about
   15 minutes away", which is all the filter promises. */
const walkMinutes = (km) => Math.round((km * 1.3) / 5 * 60);

const formatWalk = (km) => {
  const m = walkMinutes(km);
  return m <= 60 ? `~${Math.max(m, 1)} min walk` : `${km.toFixed(1)} km`;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIMES = [
  ['', 'Any time'],
  ['now', 'Now'],
  ['540', '9am'],
  ['780', '1pm'],
  ['960', '4pm'],
  ['1140', '7pm'],
  ['1320', '10pm'],
];

const WALKS = [['', 'Any walk'], ...[5, 10, 15, 20, 30].map((m) => [String(m), `≤${m} min`])];

const SORTS = [['recent', 'Newest'], ['name', 'A–Z'], ['near', 'Nearest']];

/** Day of week and minutes since midnight in London, wherever you are reading
    from — opening hours are London hours. */
function londonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    min: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const fmtClock = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/* ---------------- opening hours ---------------- */

const WEEK = 7 * 1440;

/** Opening periods as [start, end) in minutes since Sunday 00:00. */
function intervals(place) {
  const hours = place.google?.hours;
  if (!hours?.length) return null;
  return hours.map(([od, om, cd, cm]) => {
    if (cd == null) return [0, WEEK * 2];          // open around the clock
    const start = od * 1440 + om;
    let end = cd * 1440 + cm;
    if (end <= start) end += WEEK;                  // Saturday night into Sunday
    return [start, end];
  });
}

/** The period open at that moment, or null. Undefined when hours are unknown. */
function periodAt(place, day, min) {
  const iv = intervals(place);
  if (!iv) return undefined;
  const t = day * 1440 + min;
  return iv.find(([s, e]) => (t >= s && t < e) || (t + WEEK >= s && t + WEEK < e)) || null;
}

/** Does it open at some point that day? Undefined when hours are unknown. */
function opensOn(place, day) {
  const hours = place.google?.hours;
  if (!hours?.length) return undefined;
  return hours.some(([od, , cd]) => od === day || cd == null);
}

/** What the day/time controls currently ask for, resolved to London time. */
function when() {
  if (!state.day && !state.time) return null;
  const now = londonNow();
  if (state.time === 'now') return { day: now.day, min: now.min, now: true };
  const day = state.day === '' || state.day === 'today' ? now.day : Number(state.day);
  return { day, min: state.time === '' ? null : Number(state.time) };
}

function whenLabel(w) {
  if (!w) return '';
  if (w.now) return 'Open now';
  const today = londonNow().day;
  const dayName = w.day === today && state.day !== String(today) ? 'today' : DAYS[w.day];
  return w.min == null ? `Open ${dayName}` : `Open ${dayName} at ${fmtClock(w.min)}`;
}

/** "Open · until 18:00" / "Closed now" for the card, from London's clock. */
function openStatus(place) {
  const { day, min } = londonNow();
  const p = periodAt(place, day, min);
  if (p === undefined) return '';
  if (!p) return '<span class="pill pill-shut">Closed now</span>';
  if (p[1] - p[0] >= WEEK) return '<span class="pill pill-open">Open 24 hours</span>';
  return `<span class="pill pill-open">Open · until ${fmtClock(p[1] % 1440)}</span>`;
}

/* ---------------- data shaping ---------------- */

/** Your categories plus any Google's place type implies. Google's type is a
    fact about the venue (it is a coffee shop), not an opinion about it. */
function deriveCategories(place) {
  const set = new Set(place.categories || []);
  const types = new Set([place.google?.primaryType, ...(place.google?.types || [])].filter(Boolean));
  for (const c of state.data.categories) {
    if (c.types?.some((t) => types.has(t))) set.add(c.id);
  }
  return set;
}

const isFavourite = (p) => p.lists?.includes('favourites');
const wantToGo = (p) => p.lists?.includes('want-to-go');

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso + 'T00:00:00Z').getTime()) / 864e5;
}

/* Maps usually says when you saved a place; when it does not, the place's
   position in its list stands in. */
function byRecent(a, b) {
  if (a.added && b.added && a.added !== b.added) return b.added.localeCompare(a.added);
  if (a.added && !b.added) return -1;
  if (!a.added && b.added) return 1;
  const dir = state.data.meta.takeoutNewestFirst === false ? -1 : 1;
  return dir * ((a.source?.order ?? 1e9) - (b.source?.order ?? 1e9)) || a.name.localeCompare(b.name);
}

function mapsUrl(place, mode) {
  const q = encodeURIComponent(`${place.name} London`);
  const pid = place.google?.placeId;
  if (mode === 'directions') {
    return `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${q}`
      + (pid ? `&destination_place_id=${pid}` : '');
  }
  // Not linked yet: the URL you saved still points at the right place.
  if (!pid && place.source?.url) return place.source.url;
  return `https://www.google.com/maps/search/?api=1&query=${q}`
    + (pid ? `&query_place_id=${pid}` : '');
}

/* ---------------- filtering ---------------- */

function visiblePlaces() {
  const { data, categories, area, list, search, walk, sort, origin } = state;
  const term = search.trim().toLowerCase();
  const w = when();
  const maxWalk = walk ? Number(walk) : null;
  let hoursUnknown = 0;

  let out = data.places.filter((p) => {
    // Every selected category must match: "Japanese" + "Dessert" means both.
    if (categories.size && ![...categories].every((c) => p._cats.has(c))) return false;
    if (area && p.area !== area) return false;
    if (list && !p.lists?.includes(list)) return false;
    if (term) {
      const hay = [p.name, p.notes, p.area, ...(p.tags || []), ...p._cats,
        ...(p.lists || []).map((l) => listLabel(l))].join(' ').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    if (w) {
      const ok = w.min == null ? opensOn(p, w.day) : (periodAt(p, w.day, w.min) === undefined
        ? undefined : !!periodAt(p, w.day, w.min));
      if (ok === undefined) { hoursUnknown++; return false; }
      if (!ok) return false;
    }
    return true;
  });

  if (origin) {
    out = out.map((p) => ({
      ...p,
      _km: p.google?.lat != null ? haversineKm(origin, { lat: p.google.lat, lng: p.google.lng }) : Infinity,
    }));
    if (maxWalk) out = out.filter((p) => walkMinutes(p._km) <= maxWalk);
  }

  if (sort === 'near' && origin) out.sort((a, b) => a._km - b._km);
  else if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort(byRecent);

  out.hoursUnknown = hoursUnknown;
  return out;
}

const listLabel = (id) => state.data.lists?.find((l) => l.id === id)?.label || id;

/* ---------------- rendering ---------------- */

function cardHtml(place) {
  const cats = state.data.categories.filter((c) => place._cats.has(c.id)).slice(0, 2);
  const otherLists = (place.lists || []).filter((l) => l !== 'favourites' && l !== 'want-to-go');
  const w = when();
  const dayLine = w && place.google?.hoursText?.[(w.day + 6) % 7]; // Google's list starts Monday

  const meta = [
    isFavourite(place) ? '<span class="badge-fav">❤️ Favourite</span>' : '',
    wantToGo(place) ? '<span class="pill pill-want">📌 Want to go</span>' : '',
    daysSince(place.added) <= 30 ? '<span class="badge-new">New</span>' : '',
    ...cats.map((c) => `<span class="pill">${c.icon} ${c.label}</span>`),
    place.area ? `<span class="pill">${escapeHtml(place.area)}</span>` : '',
    ...otherLists.map((l) => `<span class="pill pill-list">${escapeHtml(listLabel(l))}</span>`),
    openStatus(place),
    place._km !== undefined && place._km !== Infinity ? `<span>${formatWalk(place._km)}</span>` : '',
    // Google's word, and the match was by name only, so it is surfaced rather
    // than acted on. Verified closures are removed by the monthly check.
    place.google?.businessStatus === 'CLOSED_PERMANENTLY' ? '<span class="badge-closed">Reported closed</span>' : '',
    place.google?.businessStatus === 'CLOSED_TEMPORARILY' ? '<span class="badge-closed">Temporarily closed</span>' : '',
  ].filter(Boolean).join('');

  const dishTags = place.tags || [];

  return `
    <li class="card${isFavourite(place) ? ' card-fav' : ''}">
      <h3>${escapeHtml(place.name)}</h3>
      <div class="card-meta">${meta}</div>
      ${place.notes ? `<p class="notes">${escapeHtml(place.notes)}</p>` : ''}
      ${dishTags.length ? `<p class="tags">${dishTags.map((t) => `#${escapeHtml(t)}`).join(' ')}</p>` : ''}
      ${dayLine ? `<p class="hours">🕐 ${escapeHtml(dayLine)}</p>` : ''}
      <div class="card-actions">
        <a class="map-link" href="${mapsUrl(place)}" target="_blank" rel="noopener">
          Open in Maps <span aria-hidden="true">→</span>
        </a>
        ${place.google?.lat != null ? `<a class="map-link map-link-quiet" href="${mapsUrl(place, 'directions')}"
            target="_blank" rel="noopener">🚶 Directions</a>` : ''}
      </div>
    </li>`;
}

function activeLabels() {
  const w = when();
  return [
    ...[...state.categories].map((c) => state.data.categories.find((x) => x.id === c)?.label || c),
    state.list ? listLabel(state.list) : '',
    state.area,
    whenLabel(w),
    state.walk ? `≤ ${state.walk} min walk` : '',
    state.search.trim() ? `“${state.search.trim()}”` : '',
  ].filter(Boolean);
}

function render() {
  const places = visiblePlaces();

  $('cards').innerHTML = places.map((p) => cardHtml(p)).join('');
  $('empty').hidden = places.length > 0;

  if (!state.data.places.length) {
    $('empty').textContent = 'No places yet — they appear after the first sync from Google Maps.';
  } else if (!places.length) {
    $('empty').textContent = places.hoursUnknown
      ? `Nothing fits. ${places.hoursUnknown} place(s) have no opening hours yet and were left out.`
      : 'Nothing matches those filters.';
  }

  const total = state.data.places.length;
  const active = activeLabels();
  const unknown = places.hoursUnknown ? ` · ${places.hoursUnknown} without hours hidden` : '';
  $('result-count').innerHTML = active.length
    ? `<strong>${places.length}</strong> of ${total} · ${active.map(escapeHtml).join(' · ')}${unknown}`
    : `${total} places`;

  $('clear-filters').hidden = active.length === 0;
  for (const id of ['list-filter', 'area-filter', 'day-filter', 'time-filter', 'walk-filter']) {
    $(id).classList.toggle('on', !!$(id).value);
  }
  writeHash();

  if (state.view === 'map') drawMarkers(places);
  return places;
}

/* ---------------- surprise me ---------------- */

function surprise() {
  const pool = render();
  $('pick').hidden = false;

  if (!pool.length) {
    $('pick-card').innerHTML = '<li class="empty">Nothing fits those filters — loosen one and try again.</li>';
    $('pick-again').hidden = true;
    return;
  }

  // Don't serve up the last few again while there is anything else to offer.
  const avoid = new Set(state.recentPicks.slice(-Math.min(5, pool.length - 1)));
  const fresh = pool.filter((p) => !avoid.has(p.id));
  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  state.recentPicks.push(pick.id);

  $('pick-card').innerHTML = cardHtml(pick);
  $('pick-again').hidden = pool.length < 2;
  $('pick').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

/* ---------------- location ---------------- */

async function locate() {
  if (state.origin) return true;
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000, maximumAge: 120000 }));
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    return true;
  } catch {
    alert('Could not get your location. Check location permissions for this site.');
    return false;
  }
}

/* ---------------- shareable views ---------------- */

/* The filters live in the URL, so "coffee in Shoreditch, open Saturday" is a
   link you can send. Location is never put in the URL. */
function writeHash() {
  const params = new URLSearchParams();
  if (state.categories.size) params.set('cat', [...state.categories].join(','));
  for (const k of ['list', 'area', 'day', 'time', 'walk']) if (state[k]) params.set(k, state[k]);
  if (state.sort !== 'recent') params.set('sort', state.sort);
  if (state.search.trim()) params.set('q', state.search.trim());
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const known = new Set(state.data.categories.map((c) => c.id));
  (params.get('cat') || '').split(',').filter((c) => known.has(c)).forEach((c) => state.categories.add(c));
  for (const k of ['list', 'area', 'day', 'time', 'walk', 'sort']) {
    const v = params.get(k);
    if (v != null && [...$(`${k === 'sort' ? 'sort' : `${k}-filter`}`).options].some((o) => o.value === v)) state[k] = v;
  }
  state.search = params.get('q') || '';
}

async function share() {
  const url = location.href;
  const title = activeLabels().join(' · ') || state.data.meta.title;
  try {
    if (navigator.share) return await navigator.share({ title: `${state.data.meta.title} — ${title}`, url });
    await navigator.clipboard.writeText(url);
    const btn = $('share');
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '🔗 Share'; }, 1600);
  } catch { /* share sheet dismissed */ }
}

/* ---------------- google map ---------------- */

function loadGoogleMaps() {
  if (mapsReady) return mapsReady;

  const key = window.LDNRECS?.mapsKey;
  if (!key || key.startsWith('__')) {
    mapsReady = Promise.reject(new Error('no-key'));
    return mapsReady;
  }

  mapsReady = new Promise((resolve, reject) => {
    window.__ldnrecsMapInit = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + '&loading=async&callback=__ldnrecsMapInit';
    s.async = true;
    s.onerror = () => reject(new Error('script-failed'));
    document.head.appendChild(s);
  });

  return mapsReady;
}

async function drawMarkers(places) {
  try {
    await loadGoogleMaps();
  } catch {
    $('map').hidden = true;
    $('map-fallback').hidden = false;
    return;
  }

  const { defaultCenter, defaultZoom } = state.data.meta;

  if (!map) {
    map = new google.maps.Map($('map'), {
      center: defaultCenter,
      zoom: defaultZoom,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    infoWindow = new google.maps.InfoWindow();
  }

  markers.forEach((m) => m.setMap(null));
  clusterer?.clearMarkers();
  markers = [];

  const located = places.filter((p) => p.google?.lat != null && p.google?.lng != null);

  markers = located.map((p) => {
    const marker = new google.maps.Marker({
      position: { lat: p.google.lat, lng: p.google.lng },
      title: p.name,
      label: isFavourite(p) ? { text: '♥', color: '#fff', fontSize: '12px' } : undefined,
    });
    marker.addListener('click', () => {
      infoWindow.setContent(`
        <div class="iw">
          <h3>${escapeHtml(p.name)}</h3>
          ${p.area ? `<p>${escapeHtml(p.area)}</p>` : ''}
          ${p.notes ? `<p>${escapeHtml(p.notes)}</p>` : ''}
          <a href="${mapsUrl(p, 'directions')}" target="_blank" rel="noopener">Directions →</a>
        </div>`);
      infoWindow.open({ map, anchor: marker });
    });
    return marker;
  });

  if (window.markerClusterer?.MarkerClusterer) {
    clusterer?.setMap(null);
    clusterer = new window.markerClusterer.MarkerClusterer({ map, markers });
  } else {
    markers.forEach((m) => m.setMap(map));
  }

  if (located.length) {
    const bounds = new google.maps.LatLngBounds();
    located.forEach((p) => bounds.extend({ lat: p.google.lat, lng: p.google.lng }));
    if (state.origin) bounds.extend(state.origin);
    map.fitBounds(bounds, 40);
  }
}

/* ---------------- theme ---------------- */

const THEME_KEY = 'ldnrecs-theme';

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  $('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function wireTheme() {
  setTheme(currentTheme());
  $('theme-toggle').addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}

/* ---------------- setup ---------------- */

const options = (pairs) => pairs
  .map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');

function buildControls() {
  const { categories, meta, places } = state.data;

  $('site-title').textContent = meta.title;
  $('site-subtitle').textContent = meta.subtitle;
  document.title = meta.title;

  if (meta.tips?.length) {
    $('tips').hidden = false;
    $('tips').innerHTML = meta.tips.map((t) => `<li>‼️ ${escapeHtml(t)}</li>`).join('');
  }

  // Only offer categories something actually falls into.
  const present = categories.filter((c) => places.some((p) => p._cats.has(c.id)));
  $('category-chips').innerHTML = present
    .map((c) => `<button class="chip" data-cat="${c.id}" aria-pressed="false">${c.icon} ${c.label}</button>`)
    .join('');
  $('cat-label').hidden = !present.length;
  $('category-chips').parentElement.hidden = !present.length;

  const lists = (state.data.lists || []).filter((l) => places.some((p) => p.lists?.includes(l.id)));
  $('list-filter').innerHTML = options([['', 'All saved'], ...lists.map((l) => [l.id, l.label])]);

  const areas = [...new Set(places.map((p) => p.area).filter(Boolean))].sort();
  $('area-filter').innerHTML = options([['', 'All areas'], ...areas.map((a) => [a, a])]);

  // Week starts Monday here, as it does on a London calendar.
  $('day-filter').innerHTML = options([['', 'Any day'], ['today', 'Today'],
    ...[1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), DAYS[d]])]);
  $('time-filter').innerHTML = options(TIMES);
  $('walk-filter').innerHTML = options(WALKS);
  $('sort').innerHTML = options(SORTS);
}

/** Push state back into the controls (after reading the URL or a reset). */
function syncControls() {
  document.querySelectorAll('#category-chips .chip').forEach((b) =>
    b.setAttribute('aria-pressed', String(state.categories.has(b.dataset.cat))));
  $('list-filter').value = state.list;
  $('area-filter').value = state.area;
  $('day-filter').value = state.day;
  $('time-filter').value = state.time;
  $('walk-filter').value = state.walk;
  $('sort').value = state.sort;
  $('search').value = state.search;
}

function wireEvents() {
  $('category-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const cat = btn.dataset.cat;
    const on = state.categories.has(cat);
    on ? state.categories.delete(cat) : state.categories.add(cat);
    btn.setAttribute('aria-pressed', String(!on));
    render();
  });

  $('list-filter').addEventListener('change', (e) => { state.list = e.target.value; render(); });
  $('area-filter').addEventListener('change', (e) => { state.area = e.target.value; render(); });

  // "Right now" only makes sense today, so the two controls keep each other honest.
  $('day-filter').addEventListener('change', (e) => {
    state.day = e.target.value;
    const today = String(londonNow().day);
    if (state.time === 'now' && state.day && state.day !== 'today' && state.day !== today) {
      state.time = '';
      $('time-filter').value = '';
    }
    render();
  });
  $('time-filter').addEventListener('change', (e) => {
    state.time = e.target.value;
    if (state.time === 'now' && state.day) { state.day = ''; $('day-filter').value = ''; }
    render();
  });

  $('walk-filter').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (value && !(await locate())) { e.target.value = state.walk; return; }
    state.walk = value;
    render();
  });

  $('sort').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (value === 'near' && !(await locate())) { e.target.value = state.sort; return; }
    state.sort = value;
    render();
  });

  let debounce;
  $('search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.search = e.target.value; render(); }, 120);
  });

  $('surprise').addEventListener('click', surprise);
  $('pick-again').addEventListener('click', surprise);
  $('pick-close').addEventListener('click', () => { $('pick').hidden = true; });
  $('share').addEventListener('click', share);

  const resetFilters = () => {
    Object.assign(state, { area: '', list: '', search: '', day: '', time: '', walk: '', sort: 'recent' });
    state.categories.clear();
    $('pick').hidden = true;
    syncControls();
    render();
  };

  $('clear-filters').addEventListener('click', resetFilters);

  const setView = (view) => {
    state.view = view;
    $('list-view').hidden = view !== 'list';
    $('map-view').hidden = view !== 'map';
    $('tab-list').classList.toggle('active', view === 'list');
    $('tab-map').classList.toggle('active', view === 'map');
    $('tab-list').setAttribute('aria-selected', String(view === 'list'));
    $('tab-map').setAttribute('aria-selected', String(view === 'map'));
    render();
  };
  $('tab-list').addEventListener('click', () => setView('list'));
  $('tab-map').addEventListener('click', () => setView('map'));

  const scrollToTop = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo(0, 0);
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => { if (window.scrollY > 0) window.scrollTo(0, 0); }, 600);
  };

  $('site-title').addEventListener('click', () => {
    resetFilters();
    setView('list');
    scrollToTop();
  });
}

async function init() {
  const res = await fetch('data/places.json', { cache: 'no-cache' });
  state.data = await res.json();
  state.data.places.forEach((p) => { p._cats = deriveCategories(p); });

  buildControls();
  readHash();
  syncControls();
  wireEvents();

  // A shared "within 15 min" or "nearest" link needs your location, not the sender's.
  if ((state.walk || state.sort === 'near') && !(await locate())) {
    state.walk = '';
    if (state.sort === 'near') state.sort = 'recent';
    syncControls();
  }
  render();

  const dates = state.data.places
    .flatMap((p) => [p.updated, p.google?.lastChecked]).filter(Boolean).sort();
  if (dates.length) $('last-updated').textContent = `Last updated ${dates[dates.length - 1]}`;
}

wireTheme();

(() => {
  const controls = document.querySelector('.controls');
  let compact = false;
  addEventListener('scroll', () => {
    if (!compact && scrollY > 80) { compact = true; controls.classList.add('compact'); }
    else if (compact && scrollY < 30) { compact = false; controls.classList.remove('compact'); }
  }, { passive: true });
})();

init().catch((err) => {
  console.error(err);
  $('empty').hidden = false;
  $('empty').textContent = 'Could not load the list.';
});
