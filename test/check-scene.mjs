// The scene layer (src/scene) builds on the core and three.js only: no
// module imports page code from js/, and each loads in Node. Its pure parts
// (hash state, two homes) are checked here too.
import { readFileSync, readdirSync } from "fs";

const root = new URL("../src/scene/", import.meta.url);
const SCENE = readdirSync(root).filter((f) => f.endsWith(".js")).sort();
const ok = (spec) => spec === "three" || spec.startsWith("three/addons/") || spec.startsWith("./") || spec.startsWith("../core/");

let fails = 0;
const fail = (msg) => { fails++; console.log("FAIL " + msg); };
for (const f of SCENE) {
  const code = readFileSync(new URL(f, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const [, spec] of code.matchAll(/^\s*(?:import\s*|(?:import|export)\s[^"';=]*?from\s*)["']([^"']+)["']/gm))
    if (!ok(spec)) fail(`${f} imports ${spec}`);
  try { await import(new URL(f, root)); } catch (e) { fail(`${f} does not load: ${e.message}`); }
}
const index = readFileSync(new URL("index.js", root), "utf8");
for (const f of SCENE) if (f !== "index.js" && !index.includes(`"./${f}"`)) fail(`index.js does not export ${f}`);

const { readParams, paramString, oneOf, parseCam } = await import(new URL("hash.js", root));
const defaults = { a: 1, s: "x", k: "p", cam: null };
const state = { ...defaults, a: 9 };
const h = readParams(state, defaults, { k: oneOf(["p", "q"], "p") }, "#a=2.5&s=7&k=z&cam=1,2,3,4,5,6&extra=1");
if (state.a !== 2.5 || state.s !== 7 || state.k !== "p" || String(state.cam) !== "1,2,3,4,5,6" || h.get("extra") !== "1")
  fail(`readParams gave ${JSON.stringify(state)}`);
readParams(state, defaults, {}, "#cam=1,2,x");
if (state.a !== 1 || state.cam !== null) fail("readParams does not reset to defaults or accepts a bad camera");
if (parseCam("1,2,3") !== null) fail("parseCam accepts 3 numbers");
const q = paramString({ a: 1.23456, s: "y", k: "p", cam: [1.234, 0, 0, 0, 0, 0] }, defaults, { skip: (k) => k === "k" });
if (q !== "a=1.235&s=y&cam=1.23%2C0%2C0%2C0%2C0%2C0") fail(`paramString gave ${q}`);
if (paramString({ ...defaults }, defaults) !== "") fail("paramString writes defaults");

const { placeHomes } = await import(new URL("homes.js", root));
const home = {
  n: 1, idx: new Float32Array([0.5, -0.4, -0.2]), base: new Float32Array([0, 0, 2]),
  nrm: new Float32Array([0, 0, 1]), wd: new Float32Array([-0.8])
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const at = (eh, ev, D) => Array.from(placeHomes(new Float32Array(3), home, eh, ev, D));
if (!near(at(0, 0, 2), [0.5, -0.8, -0.2])) fail(`index home is ${at(0, 0, 2)}`);
if (!near(at(1, 1, 2), [0, 0, 2 - 1.6])) fail(`world home is ${at(1, 1, 2)}`);
if (!near(at(1, 0, 1), [0, 0, 2 - 0.4])) fail(`world home at index depth is ${at(1, 0, 1)}`);

console.log(fails ? `${fails} scene failures` : `scene: ${SCENE.length} modules load in Node and import only three and the core`);
process.exit(fails ? 1 : 0);
