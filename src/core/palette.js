// Named palettes for scene layers: a scenespec palette is a name and a
// value range, so a renderer needs its own table of names. Each is a list
// of RGB stops spaced evenly from the start of the range to its end;
// values outside the range are clamped, as the spec says.

export const PALETTES = {
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  terrain: [[44, 123, 182], [171, 217, 233], [255, 255, 191], [166, 217, 106], [26, 150, 65], [140, 81, 10], [245, 245, 245]],
  ocean: [[8, 29, 88], [37, 52, 148], [34, 94, 168], [29, 145, 192], [65, 182, 196], [127, 205, 187], [199, 233, 180]],
  ice: [[4, 6, 19], [42, 52, 112], [62, 108, 160], [102, 165, 196], [168, 214, 226], [240, 250, 250]],
  blues: [[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]],
  grey: [[0, 0, 0], [255, 255, 255]],
  diverging: [[33, 102, 172], [146, 197, 222], [247, 247, 247], [244, 165, 130], [178, 24, 43]]
};

// t in 0..1 to [r, g, b] (0 to 255) along a list of stops.
export function rampAt(stops, t) {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// A scenespec palette { name, range } as v -> [r, g, b], or null for a
// name not in the table (the spec says a renderer reports that rather than
// substituting). A reversed range reverses the ramp; NaN gives null.
export function palette(p) {
  const stops = PALETTES[p && p.name];
  if (!stops) return null;
  const [lo, hi] = p.range;
  return (v) => (Number.isFinite(v) ? rampAt(stops, (v - lo) / (hi - lo)) : null);
}
