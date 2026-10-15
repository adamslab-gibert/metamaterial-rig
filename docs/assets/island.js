/* Does a pattern conform to the island algorithm that generated the data set?
   Used by the web page (live data-set size). Written so Node can load it too.

   Port of find_neighbor(), islands() and conforms() from the lab's island_generator.py:
   a pattern conforms when every empty cell touches at least two different islands
   (groups of inserts connected through edge or corner neighbours).

   classify(bits) -> true (conforms) or false (does not); null for a malformed pattern.
   bits: array of 105 numbers 0/1 in pattern-code order (index 0-5 = bottom row left to right,
   6-10 = next row up, ..., 99-104 = top row; 1 = insert). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RigIsland = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const N_CELLS = 105;

  function findNeighbor(cc) {
    let nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 1, cc + 5, cc + 6, cc + 11];
    const m = cc % 11;
    if (m === 0) nb = [cc - 11, cc - 5, cc + 1, cc + 6, cc + 11];                 // left end of a 6-cell row
    if (m === 5) nb = [cc - 11, cc - 6, cc - 1, cc + 5, cc + 11];                 // right end of a 6-cell row
    if (m === 6) nb = [cc - 11, cc - 6, cc - 5, cc + 1, cc + 5, cc + 6, cc + 11]; // left end of a 5-cell row
    if (m === 10) nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 5, cc + 6, cc + 11]; // right end of a 5-cell row
    return nb.filter(x => x >= 0 && x < N_CELLS);
  }
  const NB = Array.from({ length: N_CELLS }, (_, c) => findNeighbor(c));

  // label connected groups of inserts; returns { labels, count, largest }
  function islands(p) {
    const lab = new Array(N_CELLS).fill(0);
    let k = 0, largest = 0;
    for (let s = 0; s < N_CELLS; s++) {
      if (!p[s] || lab[s]) continue;
      k++;
      const stack = [s]; lab[s] = k; let m = 0;
      while (stack.length) {
        const u = stack.pop(); m++;
        for (const q of NB[u]) if (p[q] && !lab[q]) { lab[q] = k; stack.push(q); }
      }
      largest = Math.max(largest, m);
    }
    return { labels: lab, count: k, largest };
  }

  function conforms(p) {
    const lab = islands(p).labels;
    for (let z = 0; z < N_CELLS; z++) {
      if (p[z]) continue;
      const touch = new Set();
      for (const q of NB[z]) if (lab[q]) touch.add(lab[q]);
      if (touch.size < 2) return false;
    }
    return true;
  }

  function classify(bits) {
    if (!bits || bits.length !== N_CELLS || bits.some(b => b !== 0 && b !== 1)) return null;
    return conforms(bits);
  }

  return { classify, conforms, islands, findNeighbor };
});
