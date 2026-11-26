// Tasmanian street atlas (SA) and map book (MB) references: pages, squares
// and a point's place on its page(s), from the page and square tables
// theLIST publishes (data/tas-mapref.json, made by test/make-mapref-data.py).
//
// Everything is in GDA94 / MGA zone 55 (EPSG:28355), the frame the books
// were made in, where page and square corners are whole metres.
//
// The map book is arithmetic: pages 12 km by 18 km on a lattice with edges
// at E 4000 + 12000k and N 12000 + 18000k (one page, MB001, is 2 km off it),
// each a 24 x 36 grid of 500 m squares, columns A-X west to east and rows
// 1-36 north to south. Page numbers run in rows from north to south, west
// to east, skipping pages that are all sea, so a number needs the table.
//
// The street atlas places its pages by hand over built-up areas. Its
// squares are 500 m on the MGA 500 m lattice, 6 x 7 to a standard page
// (A-F, 1-7), inside a frame with a 75 m margin (3150 x 3650 m), so
// neighbouring frames overlap by 150 m. Pages with a suffix N, S, E, W
// (half pages) or T (small insets) carry squares labelled with their parent
// page number.

export const SQUARE = 500;
export const MB_PAGE = { w: 12000, h: 18000, x0: 4000, y0: 12000, cols: 24, rows: 36 };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The JSON tables as page and square records.
export function read(json) {
  const pages = json.page.map(([book, ref, page, suffix, xmin, ymin, xmax, ymax]) => ({ book, ref, page, suffix, xmin, ymin, xmax, ymax }));
  const sa = json.sa.map(([page, col, row, xmin, ymax, w = SQUARE, h = SQUARE]) => ({
    ref: `SA${String(page).padStart(3, "0")}${col}${row}`, page, col, row, xmin, ymax, xmax: xmin + w, ymin: ymax - h
  }));
  const byRef = new Map(pages.map((p) => [p.ref, p]));
  return { pages, sa, byRef };
}

// "SA188", "sa-188", "SA226E", "MB356" -> canonical page ref, or null
export function normPage(ref) {
  const m = /^(SA|MB)0*(\d{1,3})([NSEWT]?)$/.exec(String(ref).toUpperCase().replace(/[\s-]/g, ""));
  return m ? `${m[1]}${m[2].padStart(3, "0")}${m[3]}` : null;
}

// Printed labels: "SA-188-C4", "MB356 C4".
export function label(book, page, col, row) {
  return book === "SA" ? `SA-${page}-${col}${row}` : `MB${String(page).padStart(3, "0")} ${col}${row}`;
}

// The squares drawn on a page. MB: its 24 x 36 lattice, generated. SA: the
// published squares of the page's number whose centre is inside the frame
// (so an inset or half page carries its parent's squares).
export function squares(m, ref) {
  const p = m.byRef.get(normPage(ref) || ref);
  if (!p) return [];
  if (p.book === "MB") {
    const out = [];
    for (let r = 1; r <= MB_PAGE.rows; r++) for (let c = 0; c < MB_PAGE.cols; c++) {
      const xmin = p.xmin + c * SQUARE, ymax = p.ymax - (r - 1) * SQUARE;
      out.push({ ref: `MB${String(p.page).padStart(3, "0")}${LETTERS[c]}${r}`, page: p.page, col: LETTERS[c], row: r, xmin, ymax, xmax: xmin + SQUARE, ymin: ymax - SQUARE });
    }
    return out;
  }
  return m.sa.filter((s) => {
    if (s.page !== p.page) return false;
    const cx = (s.xmin + s.xmax) / 2, cy = (s.ymin + s.ymax) / 2;
    return cx > p.xmin && cx < p.xmax && cy > p.ymin && cy < p.ymax;
  });
}

// A page ready to draw: the frame, its squares, the extent of the squares
// (the grid) and the margin labels as printed (letters along the top and
// bottom, numbers down both sides), centred in the margin.
export function frame(m, ref) {
  const p = m.byRef.get(normPage(ref) || ref);
  if (!p) return null;
  const s = squares(m, p.ref);
  if (!s.length) return { page: p, squares: s, grid: null, cols: [], rows: [] };
  const grid = {
    xmin: Math.min(...s.map((q) => q.xmin)), ymin: Math.min(...s.map((q) => q.ymin)),
    xmax: Math.max(...s.map((q) => q.xmax)), ymax: Math.max(...s.map((q) => q.ymax))
  };
  const mt = Math.max(p.ymax - grid.ymax, 0), mb = Math.max(grid.ymin - p.ymin, 0);
  const ml = Math.max(grid.xmin - p.xmin, 0), mr = Math.max(p.xmax - grid.xmax, 0);
  const cols = [...new Map(s.map((q) => [q.col + q.xmin, q])).values()].sort((a, b) => a.xmin - b.xmin)
    .map((q) => ({ label: q.col, x: (q.xmin + q.xmax) / 2, yTop: grid.ymax + mt / 2, yBottom: grid.ymin - mb / 2 }));
  const rows = [...new Map(s.map((q) => [q.row + "," + q.ymax, q])).values()].sort((a, b) => b.ymax - a.ymax)
    .map((q) => ({ label: q.row, y: (q.ymin + q.ymax) / 2, xLeft: grid.xmin - ml / 2, xRight: grid.xmax + mr / 2 }));
  return { page: p, squares: s, grid, cols, rows, margin: { top: mt, bottom: mb, left: ml, right: mr } };
}

// Map book square for a point on a map book page, by arithmetic.
export function mbSquare(p, x, y) {
  const c = Math.floor((x - p.xmin) / SQUARE), r = Math.floor((p.ymax - y) / SQUARE) + 1;
  if (c < 0 || c >= MB_PAGE.cols || r < 1 || r > MB_PAGE.rows) return null;
  const xmin = p.xmin + c * SQUARE, ymax = p.ymax - (r - 1) * SQUARE;
  return { ref: `MB${String(p.page).padStart(3, "0")}${LETTERS[c]}${r}`, page: p.page, col: LETTERS[c], row: r, xmin, ymax, xmax: xmin + SQUARE, ymin: ymax - SQUARE };
}

// Every page whose frame holds x, y (frames overlap in their margins), with
// the square there and the place on the page: dx east and dy south of the
// frame's top-left corner, and u, v as fractions of the frame (0,0 top left).
export function locate(m, x, y, books = ["SA", "MB"]) {
  const out = [];
  for (const p of m.pages) {
    if (!books.includes(p.book) || x < p.xmin || x > p.xmax || y < p.ymin || y > p.ymax) continue;
    const sq = p.book === "MB" ? mbSquare(p, x, y)
      : squares(m, p.ref).find((s) => s.xmin <= x && x < s.xmax && s.ymin < y && y <= s.ymax) || null;
    out.push({
      book: p.book, page: p, square: sq, label: sq ? label(p.book, sq.page, sq.col, sq.row) : null,
      dx: x - p.xmin, dy: p.ymax - y, u: (x - p.xmin) / (p.xmax - p.xmin), v: (p.ymax - y) / (p.ymax - p.ymin)
    });
  }
  // main pages before their extensions, street atlas first
  return out.sort((a, b) => (a.book < b.book ? 1 : a.book > b.book ? -1 : a.page.suffix.length - b.page.suffix.length));
}

// The street atlas pages that share any ground with a page (their frames overlap).
export function neighbours(m, ref) {
  const p = m.byRef.get(ref);
  return m.pages.filter((q) => q.book === p.book && q.ref !== p.ref && q.xmin < p.xmax && q.xmax > p.xmin && q.ymin < p.ymax && q.ymax > p.ymin);
}
