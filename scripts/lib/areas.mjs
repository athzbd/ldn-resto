/* Turning coordinates into a general London area ("Covent Garden", not
 * "Covent Garden tube station").
 *
 * Nearest-centre rather than address parsing: UK addresses rarely carry the
 * neighbourhood, and postcode districts are too coarse (E1 is Whitechapel,
 * Spitalfields and half of Shoreditch). A place takes the area whose centre is
 * closest, as long as it is within MAX_KM.
 *
 * Areas with an `r` (metres) are small enclaves that would otherwise be
 * swallowed by a bigger neighbour — Chinatown sits inside Soho's catchment.
 * They are tested first and only claim places inside their radius.
 *
 * The page never edits `area` once set, so a wrong guess is fixed by writing
 * the right one into data/places.json by hand. */

export const AREAS = [
  // Small enclaves first.
  ['Chinatown', 51.5113, -0.1310, 160],
  ['Borough Market', 51.5055, -0.0910, 150],
  ['Brick Lane', 51.5215, -0.0717, 220],
  ['Columbia Road', 51.5295, -0.0705, 150],

  // Central
  ['Covent Garden', 51.5117, -0.1240],
  ['Soho', 51.5136, -0.1340],
  ['Fitzrovia', 51.5190, -0.1385],
  ['Marylebone', 51.5195, -0.1530],
  ['Mayfair', 51.5095, -0.1470],
  ["St James's", 51.5060, -0.1370],
  ['Westminster', 51.4995, -0.1335],
  ['Victoria', 51.4960, -0.1440],
  ['Pimlico', 51.4890, -0.1385],
  ['Belgravia', 51.4985, -0.1540],
  ['Knightsbridge', 51.5010, -0.1630],
  ['Chelsea', 51.4875, -0.1690],
  ['South Kensington', 51.4940, -0.1745],
  ['Kensington', 51.5005, -0.1925],
  ["Earl's Court", 51.4920, -0.1940],
  ['Notting Hill', 51.5130, -0.2005],
  ['Bayswater', 51.5120, -0.1880],
  ['Paddington', 51.5165, -0.1760],
  ['Holborn', 51.5175, -0.1180],
  ['Bloomsbury', 51.5220, -0.1265],
  ["King's Cross", 51.5320, -0.1240],
  ['Clerkenwell', 51.5235, -0.1050],
  ['The City', 51.5140, -0.0900],
  ['Shoreditch', 51.5255, -0.0790],
  ['Hoxton', 51.5330, -0.0820],
  ['Spitalfields', 51.5190, -0.0755],
  ['Whitechapel', 51.5170, -0.0600],
  ['South Bank', 51.5050, -0.1150],
  ['London Bridge', 51.5045, -0.0865],
  ['Bermondsey', 51.4975, -0.0770],
  ['Elephant & Castle', 51.4945, -0.1005],
  ['Kennington', 51.4880, -0.1110],
  ['Vauxhall', 51.4860, -0.1235],

  // North
  ['Islington', 51.5385, -0.1030],
  ['Highbury', 51.5510, -0.0990],
  ['Camden', 51.5395, -0.1426],
  ['Primrose Hill', 51.5405, -0.1580],
  ['Kentish Town', 51.5500, -0.1405],
  ['Hampstead', 51.5560, -0.1780],
  ['West Hampstead', 51.5470, -0.1910],
  ['Kilburn', 51.5410, -0.1960],
  ['Queen\'s Park', 51.5340, -0.2050],
  ['Kensal Rise', 51.5345, -0.2200],
  ['Maida Vale', 51.5280, -0.1880],
  ["St John's Wood", 51.5340, -0.1740],
  ['Holloway', 51.5520, -0.1180],
  ['Finsbury Park', 51.5640, -0.1060],
  ['Crouch End', 51.5800, -0.1235],
  ['Highgate', 51.5710, -0.1460],
  ['Muswell Hill', 51.5900, -0.1430],
  ['Tottenham', 51.5880, -0.0700],

  // East
  ['Dalston', 51.5460, -0.0750],
  ['Stoke Newington', 51.5620, -0.0750],
  ['Hackney', 51.5450, -0.0555],
  ['London Fields', 51.5410, -0.0615],
  ['Clapton', 51.5560, -0.0560],
  ['Hackney Wick', 51.5435, -0.0250],
  ['Bethnal Green', 51.5270, -0.0555],
  ['Mile End', 51.5250, -0.0335],
  ['Bow', 51.5285, -0.0200],
  ['Stratford', 51.5420, -0.0030],
  ['Walthamstow', 51.5830, -0.0200],
  ['Leyton', 51.5600, -0.0080],
  ['Wapping', 51.5040, -0.0560],
  ['Canary Wharf', 51.5050, -0.0200],

  // South
  ['Battersea', 51.4770, -0.1550],
  ['Clapham', 51.4620, -0.1385],
  ['Stockwell', 51.4720, -0.1230],
  ['Brixton', 51.4620, -0.1150],
  ['Herne Hill', 51.4530, -0.1020],
  ['Camberwell', 51.4740, -0.0925],
  ['Peckham', 51.4700, -0.0690],
  ['East Dulwich', 51.4570, -0.0750],
  ['Dulwich Village', 51.4470, -0.0860],
  ['Brockley', 51.4640, -0.0370],
  ['Deptford', 51.4780, -0.0260],
  ['Greenwich', 51.4800, -0.0090],
  ['Balham', 51.4430, -0.1525],
  ['Tooting', 51.4280, -0.1680],
  ['Wandsworth', 51.4570, -0.1920],
  ['Wimbledon', 51.4215, -0.2065],
  ['Croydon', 51.3760, -0.0985],

  // West
  ['Fulham', 51.4740, -0.2010],
  ['Putney', 51.4610, -0.2160],
  ['Barnes', 51.4720, -0.2440],
  ['Hammersmith', 51.4925, -0.2230],
  ["Shepherd's Bush", 51.5050, -0.2260],
  ['Chiswick', 51.4920, -0.2580],
  ['Ealing', 51.5130, -0.3050],
  ['Richmond', 51.4613, -0.3037],
  ['Southall', 51.5090, -0.3760],
  ['Wembley', 51.5530, -0.2970],
];

const MAX_KM = 2.2;

/* Greater London, generously boxed. Anything outside is not a London place
   (your Maps lists will have holiday saves in them too). */
export const LONDON_BOUNDS = { south: 51.28, north: 51.70, west: -0.52, east: 0.34 };

export function inLondon({ lat, lng }) {
  const b = LONDON_BOUNDS;
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.sin(dLng / 2) ** 2 * Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Best general area for a point, or null if nothing is close. */
export function areaFor(point, fallback = null) {
  if (point?.lat == null || point?.lng == null) return fallback;

  for (const [name, lat, lng, r] of AREAS) {
    if (r && haversineKm(point, { lat, lng }) * 1000 <= r) return name;
  }

  let best = null;
  let bestKm = Infinity;
  for (const [name, lat, lng, r] of AREAS) {
    if (r) continue;
    const km = haversineKm(point, { lat, lng });
    if (km < bestKm) { best = name; bestKm = km; }
  }
  return bestKm <= MAX_KM ? best : fallback;
}

/** Google's postal town ("Twickenham", "Kingston upon Thames") as a fallback
    for outer boroughs the list above does not cover. */
export function postalTown(addressComponents) {
  const c = (addressComponents || []).find((x) =>
    x.types?.includes('postal_town') || x.types?.includes('sublocality'));
  const name = c?.longText || c?.long_name;
  return name && name !== 'London' ? name : null;
}
