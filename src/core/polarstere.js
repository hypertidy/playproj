// Polar stereographic on the ellipsoid, as PROJ's +proj=stere +lat_0=+-90
// +lat_ts. Most polar rasters are stored in one of these: the Antarctic
// EPSG:3031, IBCSO's EPSG:9354 and the NSIDC sea ice grids (EPSG:3412 on
// the Hughes 1980 ellipsoid, and EPSG:3976 on WGS84). They differ only in
// the ellipsoid, the latitude of true scale and the central meridian, so
// one set of formulas (Snyder 1987, eqs 21-33 to 21-41 and 3-5) reads them
// all.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// a and 1/f
export const ELLIPSOIDS = {
  WGS84: [6378137, 298.257223563],
  hughes: [6378273, 298.279411123064]
};

export const CRS = {
  "EPSG:3031": { name: "WGS 84 / Antarctic Polar Stereographic", ellps: "WGS84", latTs: -71, lon0: 0 },
  "EPSG:9354": { name: "WGS 84 / IBCSO Polar Stereographic", ellps: "WGS84", latTs: -65, lon0: 0 },
  "EPSG:3976": { name: "WGS 84 / NSIDC Sea Ice Polar Stereographic South", ellps: "WGS84", latTs: -70, lon0: 0 },
  "EPSG:3412": { name: "NSIDC Sea Ice Polar Stereographic South (Hughes 1980)", ellps: "hughes", latTs: -70, lon0: 0 },
  "EPSG:3413": { name: "WGS 84 / NSIDC Sea Ice Polar Stereographic North", ellps: "WGS84", latTs: 70, lon0: -45 },
  "EPSG:3411": { name: "NSIDC Sea Ice Polar Stereographic North (Hughes 1980)", ellps: "hughes", latTs: 70, lon0: -45 }
};

// The PROJ string of a CRS above (or of any { ellps, latTs, lon0 }).
export function projString(c) {
  if (typeof c === "string") c = CRS[c];
  const [a, rf] = ELLIPSOIDS[c.ellps];
  const e = c.ellps === "WGS84" ? "+datum=WGS84" : `+a=${a} +rf=${rf}`;
  return `+proj=stere +lat_0=${c.latTs < 0 ? -90 : 90} +lat_ts=${c.latTs} +lon_0=${c.lon0} +k=1 +x_0=0 +y_0=0 ${e} +units=m +no_defs`;
}

const wrap180 = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

// { forward(lon, lat) -> [x, y], inverse(x, y) -> [lon, lat], k(lat) } in
// metres for a CRS key or definition. k is the scale factor along the
// parallel. |lat_ts| = 90 is true scale at the pole.
export function polarStere(c) {
  if (typeof c === "string") {
    if (!CRS[c]) throw new Error(`no polar stereographic CRS ${c}`);
    c = CRS[c];
  }
  const [a, rf] = ELLIPSOIDS[c.ellps];
  const f = 1 / rf, e2 = f * (2 - f), e = Math.sqrt(e2);
  const south = c.latTs < 0, sg = south ? -1 : 1, lon0 = c.lon0;
  const tOf = (phi) => { const s = Math.sin(phi); return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * s) / (1 + e * s), e / 2); };
  const mOf = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  // rho = a * s * t for the pole's own hemisphere
  const phic = Math.abs(c.latTs) * D2R;
  const s = Math.abs(c.latTs) === 90
    ? 2 / Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e))
    : mOf(phic) / tOf(phic);
  return {
    def: c,
    proj: projString(c),
    a, e,
    forward(lon, lat) {
      const rho = a * s * tOf(sg * lat * D2R), l = (lon - lon0) * D2R;
      return [rho * Math.sin(l), -sg * rho * Math.cos(l)];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      const t = rho / (a * s);
      let phi = Math.PI / 2 - 2 * Math.atan(t);
      for (let i = 0; i < 15; i++) {
        const es = e * Math.sin(phi);
        const next = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), e / 2));
        if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
        phi = next;
      }
      return [rho === 0 ? lon0 : wrap180(lon0 + Math.atan2(x, -sg * y) * R2D), sg * phi * R2D];
    },
    k(lat) {
      const phi = sg * lat * D2R;
      // at the pole t / m runs to its limit, 2 / sqrt((1+e)^(1+e) (1-e)^(1-e))
      if (Math.abs(phi) >= Math.PI / 2 - 1e-9) return (s * Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e))) / 2;
      return (s * tOf(phi)) / mOf(phi);
    }
  };
}

// Two polar stereographic CRSs on the same ellipsoid and meridian differ
// only by a scale: x2 = x1 * factor. Returns the factor, or null when the
// two need a full inverse and forward.
export function rescale(from, to) {
  const A = typeof from === "string" ? CRS[from] : from, B = typeof to === "string" ? CRS[to] : to;
  if (A.ellps !== B.ellps || A.lon0 !== B.lon0 || Math.sign(A.latTs) !== Math.sign(B.latTs)) return null;
  const pa = polarStere(A), pb = polarStere(B);
  const lat = Math.sign(A.latTs) * 60;
  return pb.forward(90, lat)[0] / pa.forward(90, lat)[0];
}

// The CRS key for an EPSG code, as a GeoTIFF's ProjectedCSTypeGeoKey has it.
export const fromEpsg = (code) => (CRS[`EPSG:${code}`] ? `EPSG:${code}` : null);
