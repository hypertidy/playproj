// Two homes for every vertex: one in index space, a box with y up, and one
// in the world, a point on a curved surface with its outward normal. Two
// fractions move vertices between them, eh horizontally and ev vertically,
// so a regular array can be watched becoming the thing it describes.
//
// h: { n, idx, base, nrm, wd }. idx is each vertex's box position (xyz, with
// y its height in the box), base its world position at zero height, nrm
// the outward normal there, and wd its height in the world, in the same
// units as idx's y. D scales height in both homes. out: xyz, n * 3.
export function placeHomes(out, h, eh, ev, D = 1) {
  const { n, idx, base, nrm, wd } = h;
  for (let m = 0; m < n; m++) {
    const o = 3 * m;
    const y = D * (idx[o + 1] + (wd[m] - idx[o + 1]) * ev);
    for (let c = 0; c < 3; c++) {
      const flat = c === 1 ? 0 : idx[o + c], upBox = c === 1 ? 1 : 0;
      out[o + c] = flat + (base[o + c] - flat) * eh + (upBox + (nrm[o + c] - upBox) * eh) * y;
    }
  }
  return out;
}
