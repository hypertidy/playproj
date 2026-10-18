// Every family and every grid has the shape families/index.js and grids.js
// describe, so code written against the interface works on any of them.
import { families, REQUIRED } from "../js/families/index.js";
import { rotatedPole, tripolar, cubedSphere, yinYang } from "../js/grids.js";
import { southernOcean, fan, fromArrays } from "../js/roms.js";
import { grid as s2grid, cellFromLonLat, cellFromFaceST } from "../js/s2.js";

let fails = 0;
const bad = (msg) => { fails++; console.log("FAIL " + msg); };
const angle = (a, b) => {
  const r = Math.PI / 180, c = Math.sin(a[1] * r) * Math.sin(b[1] * r) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.cos((a[0] - b[0]) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
};
const lonlats = [];
for (let lat = -80; lat <= 80; lat += 20) for (let lon = -170; lon < 180; lon += 25) lonlats.push([lon + 0.3, lat + 0.7]);

// ---------------------------------------------------------------- families

const variants = {
  perspective: [{}, { a: 0, lat0: -42, lon0: 147 }, { a: Infinity, lat0: 30 }, { a: 2.5, lat0: 60, lon0: -20 }, { ts: 60 }],
  azimuthal: [{}, { mode: "aeqd", lat0: 51.5, lon0: 0 }],
  conic: [{}, { prop: "area", lat1: -30, lon0: 140 }, { prop: "eqd", lat1: 0 }, { prop: "conf", lat1: 90 }, { tilt: 30 }],
  spilhaus: [{}],
  globals: [{}, { base: "moll", lobes: "ocean" }, { base: "robin", lobes: "none", lon0: 150 }, { base: "butterfly", lon0: -20 }]
};
let fcount = 0;
for (const [name, F] of Object.entries(families)) {
  for (const k of REQUIRED) if (typeof F[k] !== "function") bad(`${name} has no ${k}()`);
  if (!(F.R > 6e6 && F.R < 7e6)) bad(`${name} R is ${F.R}`);
  if (!F.defaults || typeof F.defaults !== "object") { bad(`${name} has no defaults`); continue; }
  for (const v of variants[name]) {
    const p = { ...F.defaults, ...v }, tag = `${name} ${JSON.stringify(v)}`;
    fcount++;
    let n = 0, worst = 0;
    for (const ll of lonlats) {
      const xy = F.project(ll[0], ll[1], p);
      if (xy === null) continue;
      if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) { bad(`${tag} project gave ${xy}`); break; }
      n++;
      if (Math.hypot(xy[0], xy[1]) > 1e4) { bad(`${tag} project ${xy} is not in sphere radii`); break; }
      if (F.inverse) {
        const back = F.inverse(xy[0], xy[1], p);
        if (back) worst = Math.max(worst, angle(ll, back));
      }
    }
    if (n < lonlats.length / 4) bad(`${tag} projects only ${n} of ${lonlats.length} points`);
    if (worst > 1e-6) bad(`${tag} inverse is off by ${worst} degrees`);
    const s = F.projString(p);
    if (s !== null && !(typeof s === "string" && s.startsWith("+proj=") && s.includes(`+R=${F.R}`))) bad(`${tag} projString ${s}`);
    const keys = F.geoKeys(p);
    if (keys !== null && !(Array.isArray(keys) && keys.every((k) => Array.isArray(k) && Number.isInteger(k[0])))) bad(`${tag} geoKeys`);
    if (typeof F.describe(p) !== "string" || !F.describe(p).length) bad(`${tag} describe`);
  }
}
console.log(`families: ${Object.keys(families).length} families, ${fcount} parameter sets`);

// ---------------------------------------------------------------- grids

const grids = {
  rotated: rotatedPole({}), tripolar: tripolar({}), cube: cubedSphere({ n: 6 }), yinyang: yinYang({}),
  southernOcean: southernOcean({ ni: 36 }), fan: fan({ ni: 20 }), s2: s2grid(2)
};
{
  const so = southernOcean({ ni: 12 });
  grids.arrays = fromArrays({ ni: so.ni, nj: so.nj, lon: so.lon, lat: so.lat });
}
let pcount = 0;
for (const [name, g] of Object.entries(grids)) {
  if (!Array.isArray(g.patches) || !g.patches.length) { bad(`${name} has no patches`); continue; }
  g.patches.forEach((p, k) => {
    const tag = `${name} patch ${k}`;
    pcount++;
    if (!(Number.isInteger(p.ni) && Number.isInteger(p.nj) && p.ni > 0 && p.nj > 0)) bad(`${tag} ni, nj ${p.ni}, ${p.nj}`);
    if (typeof p.fromIndex !== "function") { bad(`${tag} has no fromIndex`); return; }
    let worst = 0;
    for (const u of [0, 0.13, 0.5, 0.87, 1])
      for (const v of [0, 0.21, 0.5, 0.79, 1]) {
        const ll = p.fromIndex(u, v);
        if (!ll || !(Math.abs(ll[0]) <= 180 + 1e-9 && Math.abs(ll[1]) <= 90 + 1e-9)) { bad(`${tag} fromIndex(${u}, ${v}) = ${ll}`); return; }
        // the inverse is checked inside the patch, away from seams and from
        // the poles of the earth and of the grid, where it has no answer
        if (!p.toIndex || u === 0 || u === 1 || v === 0 || v === 1 || Math.abs(ll[1]) > 89) continue;
        if ((g.poles || []).some((q) => angle(q, ll) < 1)) continue;
        const uv = p.toIndex(ll[0], ll[1]);
        if (!uv) { bad(`${tag} toIndex(fromIndex(${u}, ${v})) is null`); continue; }
        worst = Math.max(worst, Math.abs(uv[0] - u), Math.abs(uv[1] - v));
      }
    if (worst > 1e-6) bad(`${tag} toIndex is off by ${worst}`);
  });
}
// s2: cell (i, j) of patch f is the cell s2 itself finds there
{
  const L = 3, g = s2grid(L);
  for (const p of g.patches)
    for (const [i, j] of [[0, 0], [3, 5], [7, 7]]) {
      const ll = p.fromIndex((i + 0.5) / p.ni, (j + 0.5) / p.nj);
      if (cellFromLonLat(ll[0], ll[1], L) !== cellFromFaceST(p.face, (i + 0.5) / p.ni, (j + 0.5) / p.nj, L)) bad(`s2 face ${p.face} cell ${i}, ${j}`);
    }
}
console.log(`grids: ${Object.keys(grids).length} grids, ${pcount} patches; ${fails ? fails + " failing" : "0 failing"}`);
if (fails) process.exit(1);
