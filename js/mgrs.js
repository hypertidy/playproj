// UTM, MGRS and the Sentinel-2 tiling grid.
//
// UTM is the transverse Mercator on the WGS84 ellipsoid, one cylinder per
// 6-degree zone, scaled by 0.9996 so it cuts the ellipsoid along two lines
// about 180 km either side of the central meridian. The projection here is
// Krueger's series to sixth order in n (Karney 2011), the same method as
// PROJ's tmerc, so it agrees with PROJ to well under a millimetre.
//
// MGRS names a UTM zone and an 8-degree latitude band (the grid zone, e.g.
// 55G), a 100 km square inside it (two letters), and then easting and
// northing digits within that square.
//
// A Sentinel-2 tile is an MGRS 100 km square, 109.8 km wide, so tiles
// overlap their neighbours by 9.8 km to the east and south. The tile's top
// left corner is the square's top left corner moved onto a 60 m grid
// (measured from easting 0 and the equator), so 10, 20 and 60 m pixels all
// line up. Its band letter is the band of the square's centre. These rules
// reproduce all 56,686 tiles of ESA's tiling grid.

const D2R = Math.PI / 180;

export const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), ECC = Math.sqrt(E2), N3 = F / (2 - F);

// Krueger series coefficients, Karney (2011) eqs 35 and 36
const n = N3, n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const RECT = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6
];
const BETA = [
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6
];

export const centralMeridian = (zone) => 6 * zone - 183;

// lon/lat (degrees) to transverse Mercator x, y in metres about lon0, before
// false easting and northing. Scale k0.
export function tmerc(lon, lat, lon0, k0 = K0) {
  let dl = ((lon - lon0 + 540) % 360) - 180;
  const lam = dl * D2R, phi = lat * D2R;
  const s = Math.sin(phi);
  const tau = Math.sinh(Math.atanh(s) - ECC * Math.atanh(ECC * s));
  const xi1 = Math.atan2(tau, Math.cos(lam));
  const eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + tau * tau));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [k0 * RECT * eta, k0 * RECT * xi];
}

export function tmercInverse(x, y, lon0, k0 = K0) {
  const xi = y / (k0 * RECT), eta = x / (k0 * RECT);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 6; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  // conformal to geodetic latitude
  let phi = chi;
  for (let i = 0; i < 12; i++) {
    const s = ECC * Math.sin(phi);
    const next = 2 * Math.atan(Math.tan(Math.PI / 4 + chi / 2) * Math.pow((1 + s) / (1 - s), ECC / 2)) - Math.PI / 2;
    if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
    phi = next;
  }
  const lon = ((lon0 + lam / D2R + 540) % 360) - 180;
  return [lon, phi / D2R];
}

// ---------------------------------------------------------------- zones and bands

export const BANDS = "CDEFGHJKLMNPQRSTUVWX";

// The band letter for a latitude: 8 degrees from 80 S, with X stretched to
// 12 degrees (72 to 84 N). C and X carry on past the MGRS limits, as the
// Sentinel-2 grid does south of 80 S.
export function bandOf(lat) {
  if (lat >= 72) return "X";
  if (lat < -72) return "C";
  return BANDS[Math.floor((lat + 80) / 8)];
}

export function bandRange(band) {
  const i = BANDS.indexOf(band);
  return [-80 + 8 * i, band === "X" ? 84 : -72 + 8 * i];
}

// The zone for a point, with the two exceptions: 32V widened over
// south-west Norway (31V narrowed to 0-3 E), and over Svalbard zones 31X,
// 33X, 35X and 37X widened to cover 32X, 34X and 36X, which do not exist.
export function zoneOf(lon, lat) {
  lon = ((lon + 540) % 360) - 180;
  let z = (Math.floor((lon + 180) / 6) % 60) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
  if (lat >= 72 && lon >= 0 && lon < 42) z = lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  return z;
}

// The longitude range of a grid zone (zone + band), or null if it does not
// exist (32X, 34X, 36X).
export function gridZoneLon(zone, band) {
  let w = 6 * zone - 186, e = w + 6;
  if (band === "V" && zone === 31) e = 3;
  if (band === "V" && zone === 32) w = 3;
  if (band === "X" && zone >= 31 && zone <= 37) {
    if (zone % 2 === 0) return null;
    w = { 31: 0, 33: 9, 35: 21, 37: 33 }[zone];
    e = { 31: 9, 33: 21, 35: 33, 37: 42 }[zone];
  }
  return [w, e];
}

// ---------------------------------------------------------------- UTM

export function epsg(zone, south) { return (south ? 32700 : 32600) + zone; }

// UTM easting and northing of a point in a given zone (the point's own zone
// by default). Northing in the south carries the 10 000 km false northing.
export function toUTM(lon, lat, zone = zoneOf(lon, lat), south = lat < 0) {
  const [x, y] = tmerc(lon, lat, centralMeridian(zone));
  return { zone, south, e: x + 500000, n: south ? y + 1e7 : y };
}

export function fromUTM(zone, south, e, nn) {
  return tmercInverse(e - 500000, south ? nn - 1e7 : nn, centralMeridian(zone));
}

// ---------------------------------------------------------------- 100 km squares

// Column letters run A-H, J-R, S-Z (no I or O) in zones 1, 2, 3 and again
// from zone 4. Row letters run A-V every 2000 km of northing, starting from
// F in even zones (the "AA" scheme used with WGS84).
const COLSETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
export const ROWS = "ABCDEFGHJKLMNPQRSTUV";

export function squareLetters(zone, col, row) {
  if (col < 1 || col > 8) return null;
  const r = (((row + (zone % 2 === 0 ? 5 : 0)) % 20) + 20) % 20;
  return COLSETS[(zone - 1) % 3][col - 1] + ROWS[r];
}

// The 100 km column (1-8) and row (northing / 100 km, false northing
// included) named by two letters in a zone; the row is known only modulo
// 20, so it is returned in 0-19.
export function squareIndex(zone, letters) {
  const col = COLSETS[(zone - 1) % 3].indexOf(letters[0]) + 1;
  const r = ROWS.indexOf(letters[1]);
  if (col < 1 || r < 0) return null;
  return { col, row: (r - (zone % 2 === 0 ? 5 : 0) + 20) % 20 };
}

const pad = (v, d) => String(Math.floor(v)).padStart(5, "0").slice(0, d);

// MGRS reference for a point, `digits` per coordinate (5 = 1 m, 0 = the
// 100 km square only). Valid from 80 S to 84 N.
export function toMGRS(lon, lat, digits = 5) {
  if (!(lat >= -80 && lat < 84)) return null;
  const u = toUTM(lon, lat);
  const col = Math.floor(u.e / 1e5), row = Math.floor(u.n / 1e5);
  const sq = squareLetters(u.zone, col, row);
  const ze = u.e - col * 1e5, zn = u.n - row * 1e5;
  return {
    ...u, band: bandOf(lat), square: sq,
    gzd: String(u.zone).padStart(2, "0") + bandOf(lat),
    ref: String(u.zone).padStart(2, "0") + bandOf(lat) + sq + (digits ? pad(ze, digits) + pad(zn, digits) : "")
  };
}

// An MGRS reference back to the south-west corner of the cell it names, as
// lon/lat, with the UTM coordinates and the cell size in metres. Spaces are
// ignored; returns null if it cannot be read.
export function parseMGRS(text) {
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/.exec(text.replace(/\s+/g, "").toUpperCase());
  if (!m || m[5].length % 2 || m[5].length > 10) return null;
  const zone = +m[1], band = m[2];
  if (zone < 1 || zone > 60 || !gridZoneLon(zone, band)) return null;
  const idx = squareIndex(zone, m[3] + m[4]);
  if (!idx) return null;
  const d = m[5].length / 2, size = 10 ** (5 - d);
  const de = d ? +m[5].slice(0, d) * size : 0, dn = d ? +m[5].slice(d) * size : 0;
  const south = band < "N", e = idx.col * 1e5 + de;
  // the northing is known modulo 2000 km: take the one whose latitude falls
  // in the band (or nearest its middle)
  const [b0, b1] = bandRange(band), mid = (b0 + b1) / 2;
  let best = null;
  for (let k = 0; k < 10; k++) {
    const nn = (idx.row + 20 * k) * 1e5 + dn;
    if (nn > (south ? 1e7 : 9.5e6)) break;
    const [lon, lat] = fromUTM(zone, south, e, nn);
    if (!isFinite(lat)) continue;
    const ok = lat >= b0 - 0.5 && lat < b1 + 0.5;
    const score = ok ? Math.abs(lat - mid) : 1e3 + Math.abs(lat - mid);
    if (!best || score < best.score) best = { score, lon, lat, zone, band, south, e, n: nn, size };
  }
  if (!best || best.score > 1e3) return null;
  delete best.score;
  return best;
}

// ---------------------------------------------------------------- Sentinel-2 tiles

export const TILE = 109800;
const snapDown = (v) => Math.floor(v / 60) * 60;
const snapUp = (v) => Math.ceil(v / 60) * 60;

// The square (col, row) in a zone and hemisphere as a tile: name, UTM
// bounds, and the EPSG code its images are delivered in.
export function tileOfSquare(zone, south, col, row) {
  const sq = squareLetters(zone, col, row);
  if (!sq) return null;
  const [, latc] = fromUTM(zone, south, col * 1e5 + 5e4, row * 1e5 + 5e4);
  const fn = south ? 1e7 : 0;
  const xmin = snapDown(col * 1e5), ymax = snapUp((row + 1) * 1e5 - fn) + fn;
  return {
    name: String(zone).padStart(2, "0") + bandOf(latc) + sq, zone, south, col, row,
    xmin, xmax: xmin + TILE, ymin: ymax - TILE, ymax, epsg: epsg(zone, south)
  };
}

// A tile from its name (e.g. "55GEN" or "T55GEN").
export function tileByName(name) {
  const m = /^T?(\d{2})([C-HJ-NP-X])([A-HJ-NP-Z][A-HJ-NP-V])$/.exec(String(name).trim().toUpperCase());
  if (!m) return null;
  const zone = +m[1], band = m[2], idx = squareIndex(zone, m[3]);
  if (!idx || zone < 1 || zone > 60) return null;
  const south = band < "N";
  for (let k = 0; k < 10; k++) {
    const t = tileOfSquare(zone, south, idx.col, idx.row + 20 * k);
    if (t && t.name === m[1] + band + m[3]) return t;
  }
  return null;
}

// The tile's outline as lon/lat, `per` points along each edge, closed,
// anticlockwise (GeoJSON order).
export function tileRing(t, per = 1) {
  const c = [[t.xmin, t.ymin], [t.xmax, t.ymin], [t.xmax, t.ymax], [t.xmin, t.ymax]];
  const ring = [];
  for (let k = 0; k < 4; k++) {
    const [x0, y0] = c[k], [x1, y1] = c[(k + 1) % 4];
    for (let i = 0; i < per; i++) ring.push(fromUTM(t.zone, t.south, x0 + ((x1 - x0) * i) / per, y0 + ((y1 - y0) * i) / per));
  }
  ring.push(ring[0]);
  return ring;
}

// The tiling grid: which squares have a tile, from data/s2-tiles.json.
export function tileSet(json) {
  const masks = new Map();
  for (const [k, hex] of Object.entries(json.tiles)) masks.set(k, BigInt("0x" + hex));
  const has = (name) => {
    const m = masks.get(name.slice(0, 3));
    if (m === undefined) return false;
    const zone = +name.slice(0, 2);
    const ci = COLSETS[(zone - 1) % 3].indexOf(name[3]), ri = ROWS.indexOf(name[4]);
    return ci >= 0 && ri >= 0 && ((m >> BigInt(ci * 20 + ri)) & 1n) === 1n;
  };
  // every tile in a zone, by walking its squares
  const inZone = (zone) => {
    const out = [];
    for (const south of [false, true])
      for (let row = 0; row < (south ? 100 : 95); row++)
        for (let col = 1; col <= 8; col++) {
          const t = tileOfSquare(zone, south, col, row);
          if (t && has(t.name)) out.push(t);
        }
    return out;
  };
  return { has, inZone, count: json.count };
}

// Every tile containing a point. Tiles reach past their zone's edge (by
// up to 410 km from the central meridian, so near the poles several zones
// away), and northern tiles start 9.8 km south of the equator, so every
// zone and both hemispheres near the equator are tried. `has` filters to
// tiles in the grid; without it every candidate square is returned.
export function tilesAt(lon, lat, has = null) {
  const out = [];
  for (let zone = 1; zone <= 60; zone++) {
    if (Math.abs(((lon - centralMeridian(zone) + 540) % 360) - 180) > 90) continue;
    const [x, y] = tmerc(lon, lat, centralMeridian(zone));
    if (!(Math.abs(x) < 4.1e5)) continue;
    const e = x + 500000;
    for (const south of [false, true]) {
      if (south ? lat > 1 : lat < -1) continue;
      const nn = south ? y + 1e7 : y;
      const c0 = Math.floor(e / 1e5), r0 = Math.floor(nn / 1e5);
      // the 60 m snap moves a tile's corner up to 60 m west or north, so
      // the squares either side are tried as well as the one below-left
      for (let col = c0 - 1; col <= c0 + 1; col++)
        for (let row = r0 - 1; row <= r0 + 1; row++) {
          if (south ? row > 99 : row < 0) continue;
          const t = tileOfSquare(zone, south, col, row);
          if (!t || e < t.xmin || e > t.xmax || nn < t.ymin || nn > t.ymax) continue;
          if (has && !has(t.name)) continue;
          out.push(t);
        }
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
