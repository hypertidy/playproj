// A ship's track from underway data: the voyages of RSV Nuyina as the
// Australian Antarctic Data Centre serves them (one row a minute from the
// ship's underway system, by voyage code), read from CSV with whatever the
// columns are called, and the ship's place, heading and distance run at
// any time along it.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const EARTH_KM = 6371.0088;   // mean radius, for distance run

// The AADC's underway feature service (GeoServer WFS) and the voyages it
// holds, with the record each voyage's data is published under.
export const WFS = "https://data.aad.gov.au/geoserver/underway/ows";
export const LAYER = "underway:nuyina_underway";

export const VOYAGES = [
  { code: "202526010", label: "2025-26 V1", from: "2025-09-26", to: "2025-11-16", about: "Casey fly-off, Davis over-ice resupply, Heard Island",
    record: "https://researchdata.edu.au/rsv-nuyina-voyage-26-v1/3952976", stops: ["hobart", "casey", "davis", "heard"] },
  { code: "202425040", label: "2024-25 V4", from: "2025-05-06", to: "2025-06-06", about: "Macquarie Island resupply",
    record: "https://researchdata.edu.au/rsv-nuyina-voyage-25-v4/3748442", stops: ["hobart", "macquarie"] },
  { code: "202425030", label: "2024-25 V3", from: "2025-02-28", to: "2025-05-01", about: "Denman Glacier marine science",
    record: "https://researchdata.edu.au/rsv-nuyina-voyage-25-v3/3748439", stops: ["hobart", "denman"] },
  { code: "202425010", label: "2024-25 V1", from: "2024-10-08", to: "2024-11-16", about: "Davis resupply via Casey",
    record: "https://researchdata.edu.au/rsv-nuyina-voyage-25-v1/3650887", stops: ["hobart", "casey", "davis"] },
  { code: "202324V1", label: "2023-24 V1", from: "2023-10-09", to: "2023-12-01", about: "Davis resupply",
    record: "https://researchdata.edu.au/rsv-nuyina-voyage-24-v1/3650863", stops: ["hobart", "davis"] }
];

export const PLACES = {
  hobart: { name: "Hobart", lon: 147.3272, lat: -42.8821 },
  macquarie: { name: "Macquarie Island", lon: 158.9369, lat: -54.4994 },
  casey: { name: "Casey", lon: 110.5267, lat: -66.2825 },
  davis: { name: "Davis", lon: 77.9674, lat: -68.5766 },
  mawson: { name: "Mawson", lon: 62.8742, lat: -67.6033 },
  heard: { name: "Heard Island", lon: 73.39, lat: -53.02 },
  denman: { name: "Denman Glacier", lon: 99.42, lat: -66.75 }
};

// A GetFeature request for one voyage as CSV: only the named properties
// when given, at most max rows when given.
export function wfsUrl(code, { props = null, max = 0 } = {}) {
  const q = new URLSearchParams({ service: "WFS", version: "1.0.0", request: "GetFeature", typeName: LAYER, outputFormat: "csv" });
  q.set("cql_filter", `set_code='${code}'`);
  if (props && props.length) q.set("propertyName", props.join(","));
  if (max) q.set("maxFeatures", String(max));
  return `${WFS}?${q}`;
}

// ------------------------------------------------------------------ CSV

// Rows of a CSV as arrays of strings, with quoted fields ("a, b" and "")
// as RFC 4180 has them.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// The columns that hold time, longitude and latitude (or a WKT point), by
// name; -1 where none matches.
export function detectColumns(header) {
  const h = header.map((s) => s.trim().toLowerCase());
  const find = (...res) => {
    for (const re of res) { const i = h.findIndex((s) => re.test(s)); if (i >= 0) return i; }
    return -1;
  };
  return {
    time: find(/^date_?time(_utc)?$/, /^(time|timestamp|datetime_utc|date)$/, /date_?time/, /time/),
    lon: find(/^(longitude|lon|long|lng)$/, /^longitude/, /longitude/),
    lat: find(/^(latitude|lat)$/, /^latitude/, /latitude/),
    geom: find(/^(the_geom|geom|geometry|wkt|shape)$/)
  };
}

// lon, lat from "POINT (lon lat)" (any case, optional Z), or null.
export function wktPoint(s) {
  const m = /POINT\s*Z?\s*\(\s*([-+0-9.eE]+)\s+([-+0-9.eE]+)/i.exec(s || "");
  return m ? [+m[1], +m[2]] : null;
}

// Numeric columns other than position and time: the ones a track can be
// coloured by.
export function numericColumns(rows, cols) {
  const [header, ...body] = rows, out = [];
  const skip = new Set([cols.time, cols.lon, cols.lat, cols.geom]);
  const sample = body.slice(0, 50);
  header.forEach((name, i) => {
    if (skip.has(i) || !sample.length) return;
    const ok = sample.filter((r) => r[i] !== "" && r[i] !== undefined && Number.isFinite(+r[i])).length;
    if (ok >= Math.max(1, sample.length * 0.5)) out.push(name);
  });
  return out;
}

// A time in ms from an ISO string (a missing zone is UTC) or a number.
export function parseTime(s) {
  if (s === undefined || s === "") return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  let t = s.trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += "Z";
  return Date.parse(t);
}

// A track from CSV text: arrays t (ms), lon, lat and value (the column
// named by, or NaN), sorted by time, with rows lacking a time or a place
// dropped and repeated times kept once.
export function trackFromCSV(text, by = "") {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("no rows");
  const cols = detectColumns(rows[0]);
  if (cols.time < 0) throw new Error(`no time column in ${rows[0].join(", ")}`);
  if ((cols.lon < 0 || cols.lat < 0) && cols.geom < 0) throw new Error(`no longitude and latitude in ${rows[0].join(", ")}`);
  const vi = by ? rows[0].findIndex((s) => s.trim() === by) : -1;
  const recs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const t = parseTime(row[cols.time]);
    const num = (c) => (c >= 0 && row[c] !== undefined && row[c].trim() !== "" ? +row[c] : NaN);
    let lon = num(cols.lon), lat = num(cols.lat);
    if (!(Number.isFinite(lon) && Number.isFinite(lat)) && cols.geom >= 0) {
      const p = wktPoint(row[cols.geom]);
      if (p) [lon, lat] = p;
    }
    if (!Number.isFinite(t) || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    recs.push([t, lon, lat, vi >= 0 && row[vi] !== "" ? +row[vi] : NaN]);
  }
  return makeTrack(recs, { columns: rows[0], numeric: numericColumns(rows, cols), by: vi >= 0 ? by : "" });
}

// A track from [t, lon, lat, value] records.
export function makeTrack(recs, meta = {}) {
  recs.sort((a, b) => a[0] - b[0]);
  const keep = recs.filter((r, i) => i === 0 || r[0] !== recs[i - 1][0]);
  const n = keep.length;
  if (n < 2) throw new Error("fewer than two points");
  const t = new Float64Array(n), lon = new Float64Array(n), lat = new Float64Array(n), value = new Float64Array(n), dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    [t[i], lon[i], lat[i], value[i]] = keep[i];
    if (i) dist[i] = dist[i - 1] + greatCircle(lon[i - 1], lat[i - 1], lon[i], lat[i]);
  }
  return { n, t, lon, lat, value, dist, start: t[0], end: t[n - 1], ...meta };
}

// km along the great circle on the mean sphere.
export function greatCircle(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing (degrees clockwise from north) from one point to another.
export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * R2D) + 360) % 360;
}

// The index i with t[i] <= time < t[i + 1] (clamped to the ends).
export function indexAt(tr, time) {
  let lo = 0, hi = tr.n - 1;
  if (time <= tr.t[0]) return 0;
  if (time >= tr.t[hi]) return hi - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr.t[mid] <= time) lo = mid; else hi = mid; }
  return lo;
}

// The ship at a time: lon, lat (linear between fixes, longitude taken the
// short way round), heading over the fixes about `span` ms either side,
// distance run (km) and the value column.
export function at(tr, time, span = 10 * 60e3) {
  const i = indexAt(tr, time), f = Math.max(0, Math.min(1, (time - tr.t[i]) / (tr.t[i + 1] - tr.t[i] || 1)));
  let dl = tr.lon[i + 1] - tr.lon[i];
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  const lon = ((tr.lon[i] + f * dl + 540) % 360) - 180, lat = tr.lat[i] + f * (tr.lat[i + 1] - tr.lat[i]);
  const a = indexAt(tr, time - span), b = Math.min(tr.n - 1, indexAt(tr, time + span) + 1);
  const moved = greatCircle(tr.lon[a], tr.lat[a], tr.lon[b], tr.lat[b]);
  const heading = moved > 0.05 ? bearing(tr.lon[a], tr.lat[a], tr.lon[b], tr.lat[b]) : null;
  const hours = (tr.t[b] - tr.t[a]) / 3.6e6;
  return {
    i, lon, lat, heading, time,
    knots: hours > 0 ? moved / 1.852 / hours : 0,
    dist: tr.dist[i] + f * (tr.dist[i + 1] - tr.dist[i]),
    value: f < 0.5 ? tr.value[i] : tr.value[i + 1]
  };
}

// Every k-th index (and the last) so that at most max points remain, for
// drawing a long track.
export function thin(tr, max = 6000) {
  const k = Math.max(1, Math.ceil(tr.n / max)), out = [];
  for (let i = 0; i < tr.n; i += k) out.push(i);
  if (out[out.length - 1] !== tr.n - 1) out.push(tr.n - 1);
  return out;
}

// A schematic of a voyage when its data cannot be read: the ports of call
// in order, there and back, on a day's spacing per 600 km. It is not a
// track, and pages should say so.
export function portsOfCall(voyage) {
  const stops = voyage.stops.map((k) => PLACES[k]);
  const legs = [...stops, stops[0]];
  const recs = [];
  let t = Date.parse(voyage.from + "T00:00:00Z");
  for (let s = 0; s < legs.length - 1; s++) {
    const a = legs[s], b = legs[s + 1], d = greatCircle(a.lon, a.lat, b.lon, b.lat), n = Math.max(2, Math.ceil(d / 50));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const [lon, lat] = slerp(a, b, f);
      recs.push([t + f * (d / 600) * 864e5, lon, lat, NaN]);
    }
    t += (d / 600) * 864e5;
  }
  recs.push([t, legs[legs.length - 1].lon, legs[legs.length - 1].lat, NaN]);
  return makeTrack(recs, { schematic: true, columns: [], numeric: [], by: "" });
}

function slerp(a, b, f) {
  const v = (p) => [Math.cos(p.lat * D2R) * Math.cos(p.lon * D2R), Math.cos(p.lat * D2R) * Math.sin(p.lon * D2R), Math.sin(p.lat * D2R)];
  const A = v(a), B = v(b);
  const w = Math.acos(Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const s = Math.sin(w) || 1, ka = Math.sin((1 - f) * w) / s, kb = Math.sin(f * w) / s;
  const x = ka * A[0] + kb * B[0], y = ka * A[1] + kb * B[1], z = ka * A[2] + kb * B[2];
  return [Math.atan2(y, x) * R2D, Math.atan2(z, Math.hypot(x, y)) * R2D];
}
