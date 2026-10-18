// Land mesh from the coastlines: it should cover about 29% of the sphere,
// hold the land and not the water (the Caspian is a hole), and the samples
// should come from where the land is.
import { readFileSync } from "fs";
import { landTriangles, landMesh, samplePoints, evenLand, evenSpacing, isLand } from "../src/core/landmesh.js";

const D2R = Math.PI / 180;
const land = [[2.3, 48.8, "Paris"], [20, 20, "Sahara"], [-60, -10, "Amazon"], [134, -25, "Australia"],
  [-42, 72, "Greenland"], [0, -89, "South Pole"], [-175, 66.5, "Chukotka"], [100, 60, "Siberia"]];
const water = [[51, 42, "Caspian"], [-150, 0, "Pacific"], [-30, 30, "Atlantic"], [80, -20, "Indian Ocean"], [0, 89, "North Pole"]];

const inTri = (x, y, [a, b, c]) => {
  const s = (u, v) => (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
  const s1 = s(a, b), s2 = s(b, c), s3 = s(c, a);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
const onLand = (tris, lon, lat) => [0, 360, -360].some((d) => tris.some((t) => inTri(lon + d, lat, t)));

let fails = 0;
for (const detail of ["110m", "50m"]) {
  const coast = JSON.parse(readFileSync(new URL(`../data/coastline-${detail}.json`, import.meta.url)));
  const tris = landTriangles(coast);
  const mesh = landMesh(coast);
  const frac = mesh.cents.reduce((s, c) => s + c[2], 0) * D2R * D2R / (4 * Math.PI);
  const bad = [];
  if (!(frac > 0.27 && frac < 0.31)) bad.push(`land fraction ${frac.toFixed(4)}`);
  for (const [lon, lat, name] of land) if (!onLand(tris, lon, lat)) bad.push(`${name} not land`);
  for (const [lon, lat, name] of water) if (onLand(tris, lon, lat)) bad.push(`${name} is land`);
  for (const mode of ["tri", "vert", "coast"]) {
    const a = samplePoints(coast, mode, 7, 500), b = samplePoints(coast, mode, 7, 500);
    if (a.length !== 500 || JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${mode} sample not repeatable`);
    if (a.some(([lon, lat]) => !(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90))) bad.push(`${mode} sample out of range`);
  }
  // the even lattice: about the asked-for count, all on land, and no two
  // points much closer than the lattice spacing
  for (const want of [200, 2000]) {
    const pts = evenLand(coast, want, 1);
    if (Math.abs(pts.length - want) > 0.05 * want) bad.push(`even ${want} gave ${pts.length}`);
    if (pts.some(([lon, lat]) => !onLand(tris, lon, lat))) bad.push(`even ${want} point off land`);
    const sp = evenSpacing(coast, want) * D2R;
    let minD = Infinity;
    const xyz = pts.map(([lon, lat]) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)]);
    for (let i = 0; i < xyz.length; i++)
      for (let j = i + 1; j < xyz.length; j++) {
        const d = Math.acos(Math.min(1, xyz[i][0] * xyz[j][0] + xyz[i][1] * xyz[j][1] + xyz[i][2] * xyz[j][2]));
        if (d < minD) minD = d;
      }
    if (minD < 0.5 * sp) bad.push(`even ${want} closest pair ${(minD / sp).toFixed(2)} of the spacing`);
  }
  for (const [lon, lat, name] of land) if (!isLand(coast, lon, lat)) bad.push(`isLand: ${name}`);
  for (const [lon, lat, name] of water) if (isLand(coast, lon, lat)) bad.push(`isLand: ${name}`);
  if (bad.length) { fails++; console.log(`FAIL ${detail}: ${bad.join("; ")}`); }
  console.log(`landmesh ${detail}: ${tris.length} triangles, ${mesh.verts.length} vertices, land ${(100 * frac).toFixed(1)}% of the sphere`);
}
if (fails) process.exit(1);
