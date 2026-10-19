// Page state in the URL hash. Every setting has a default and is written only
// where it differs, so a short link (or an embed) carries the whole view.

// "x,y,z,tx,ty,tz" as a camera position and orbit target, or null.
export function parseCam(raw) {
  const c = String(raw).split(",").map(Number);
  return c.length === 6 && c.every(isFinite) ? c : null;
}

// A parser that keeps raw when it is one of list, else fallback.
export const oneOf = (list, fallback) => (raw) => (list.includes(raw) ? raw : fallback);

// Reset state to defaults, then take each default's key from the hash:
// parse[k](raw) where the page gives one (undefined keeps the default),
// a camera for "cam", and a number for anything numeric. The parsed hash is
// returned for keys the page reads itself (old links, say).
export function readParams(state, defaults, parse = {}, hash = location.hash) {
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (parse[k]) {
      const v = parse[k](raw);
      if (v !== undefined) state[k] = v;
    } else if (k === "cam") {
      const c = parseCam(raw);
      if (c) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  return h;
}

// The hash for state: keys that differ from their defaults, numbers rounded
// to digits and the camera to 2, leaving out any key skip(k) says to.
export function paramString(state, defaults, { digits = 3, skip = () => false } = {}) {
  const h = new URLSearchParams();
  for (const k of Object.keys(defaults)) {
    if (skip(k)) continue;
    if (k === "cam") {
      if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(","));
      continue;
    }
    const v = typeof state[k] === "number" ? +state[k].toFixed(digits) : state[k];
    if (v !== defaults[k]) h.set(k, String(v));
  }
  return h.toString();
}

// A function that writes state to the hash a moment after the last call,
// replacing the history entry rather than adding one.
export function hashWriter(state, defaults, opts = {}) {
  const { delay = 200 } = opts;
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = paramString(state, defaults, opts);
      history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
    }, delay);
  };
}
