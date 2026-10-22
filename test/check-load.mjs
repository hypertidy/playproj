// The loading layer (src/load) and the mesh frame: a scenespec 0.7 mesh
// scene read with apache-arrow from test/fixtures/scene (the conformance
// mesh of allboa/scenespec), coloured from its face column, and unfolded
// from EPSG:3031 onto the WGS84 ellipsoid. The earth home is checked
// against proj4js and the ellipsoid directly.
import { readFileSync } from "fs";
import { tableFromIPC } from "apache-arrow";
import proj4 from "proj4";
import * as S from "../src/load/scene.js";
import { palette, PALETTES } from "../src/core/palette.js";
import { mapHome, earthHome, homeGap, blend } from "../src/core/meshframe.js";
import { ellipsoid, toXYZ } from "../src/core/ellipsoid.js";
import { knownProj4 } from "../src/core/structure.js";

let fails = 0;
const fail = (msg) => { fails++; console.log("FAIL " + msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// fetch for file: URLs, enough for loadScene
const fileFetch = async (url) => {
  const bytes = readFileSync(new URL(url));
  return { ok: true, status: 200, json: async () => JSON.parse(bytes.toString("utf8")),
    text: async () => bytes.toString("utf8"), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
};

const url = new URL("fixtures/scene/polar-mesh.json", import.meta.url).href;
const loaded = await S.loadScene(url, { tableFromIPC, fetch: fileFetch });
if (loaded.tables.size !== 3) fail(`read ${loaded.tables.size} tables, not 3`);
const layer = loaded.scene.layers[0];
const mesh = S.meshArrays(loaded, layer);
if (mesh.nv !== 16 || mesh.ntri !== 18 || mesh.size !== 3) fail(`mesh is ${mesh.nv} vertices, ${mesh.ntri} triangles, size ${mesh.size}`);
if (Math.max(...mesh.index) !== 15) fail("indices do not reach the last vertex");
const ext = S.extentOf(mesh.position, mesh.size);
if (String(ext) !== "-1500000,1500000,-1500000,1500000") fail(`extent ${ext}`);
if (String(mesh.origin) !== "0,0") fail(`origin ${mesh.origin} for data not origin subtracted`);

// face colours: one colour per triangle, from the terrain palette over 0..10
const { colour, flat } = S.meshColours(mesh, layer, palette);
const count = S.numbers(mesh.faces, "count");
const want = palette(layer.fill_by.palette)(count[5]);
if (!flat || colour.length !== 18 * 9) fail("face colouring is not one colour per triangle");
for (let k = 0; k < 3; k++) if (!near(colour[45 + 3 * k] * 255, want[0], 1e-3)) fail(`triangle 5 vertex ${k} colour`);
if (palette({ name: "nope", range: [0, 1] }) !== null) fail("an unknown palette name is not null");
if (String(palette({ name: "grey", range: [10, 0] })(10)) !== "0,0,0") fail("a reversed range does not reverse the ramp");
for (const [name, stops] of Object.entries(PALETTES)) if (stops.some((s) => s.length !== 3)) fail(`palette ${name}`);

// popups from the face table
const pop = S.facePopup(mesh, layer, 4);
if (pop.length !== 2 || pop[0][0] !== "count" || pop[0][1] !== count[4] || pop[1][1] !== 2) fail(`popup ${JSON.stringify(pop)}`);

// the two homes
const def = knownProj4(3031);
const inv = (x, y) => proj4(def, "EPSG:4326", [x, y]);
const E = ellipsoid(6378137, 1 / 298.257223563);
const flatHome = mapHome(mesh.position, 3, 1);
if (flatHome[1] !== mesh.position[2] || flatHome[2] !== -mesh.position[1]) fail("map home axes are not (x, h, -y)");
const { out: earth, lonlat0 } = earthHome(mesh.position, 3, [0, 0], inv, E, 1);
if (!near(lonlat0[1], -90, 1e-9)) fail(`origin latitude ${lonlat0[1]}`);
// a corner, independently: its Earth-centred position less the pole's
const k = 0, ll = inv(mesh.position[0], mesh.position[1]), h = mesh.position[2];
const c = toXYZ(E, ll[0], ll[1], h), c0 = toXYZ(E, 0, -90, 0);
const len = Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]);
const got = Math.hypot(earth[k], earth[k + 1], earth[k + 2]);
if (!near(got, len, 1e-3 * len)) fail(`earth home of vertex 0 is ${got} m from the origin, not ${len}`);
// at 2121 km from the pole the earth drops below the tangent plane by about d^2 / 2R
const d = Math.hypot(mesh.position[0], mesh.position[1]);
const drop = flatHome[1] - earth[1];
if (!(drop > 0.8 * (d * d) / (2 * 6371000) && drop < 1.2 * (d * d) / (2 * 6371000))) fail(`corner drops ${drop} m`);
const gap = homeGap(flatHome, earth);
if (!(gap.max > 1e5)) fail(`the homes of a 3000 km mesh differ by only ${gap.max} m`);
const mid = blend(new Float32Array(earth.length), flatHome, earth, 0.5);
if (!near(mid[1], (flatHome[1] + earth[1]) / 2, 1)) fail("blend is not halfway");

// a small mesh far from the pole: the homes agree to the scale factor
const pos = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]);
const utm = knownProj4(32608), o = [534011, 6462469];
const invU = (x, y) => proj4(utm, "EPSG:4326", [x, y]);
const small = earthHome(pos, 3, o, invU, E, 1).out;
const m100 = Math.hypot(small[3], small[4], small[5]);
if (!near(m100, 100 / 0.99961, 0.02)) fail(`100 m of UTM 8N near Juneau is ${m100} m on the ellipsoid`);

console.log(fails ? `${fails} load failures` : "load: a scenespec mesh scene reads, colours, pops up and unfolds onto the ellipsoid");
process.exit(fails ? 1 : 0);
