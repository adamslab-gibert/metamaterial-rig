"""Build the website's copy of the data set (docs/data/) from the lab's .npy files.

The page counts these runs, split by the island rule, and offers them for download together
with every run tested from the public queue (results/dataset_additions.csv).

Usage (one or more sets; each set = patterns, force curves, displacements, rows aligned):
  python lab/build_web_dataset.py --set codeData.npy dataData.npy maxData.npy
  python lab/build_web_dataset.py --set codeData.npy dataData.npy maxData.npy \
                                  --set codeData_sets1-4.npy dataData_sets1-4.npy maxData_sets1-4.npy

Each pattern is kept once: if a pattern appears more than once, the first occurrence is kept
(so list the preferred set first). Patterns may be N x 19 x 11 arrays (codeData, row 0 = top) or N 105-digit strings (codeList,
bottom row first). Writes docs/data/codeData.npy (uint8), dataData.npy (float32),
maxData.npy (float64), island.npy (uint8), keys.txt and summary.json. Then commit and push docs/data/.
"""
import argparse
import json
import os
from datetime import date

import numpy as np

N_CELLS = 105
# (row, column) of each position in the 105-digit code: bottom row first, left to right
RC = [(r, c) for r in range(18, -1, -1) for c in (range(0, 11, 2) if r % 2 == 0 else range(1, 10, 2))]


# ---- island rule: identical to find_neighbor / islands / conforms in island_generator.py
def find_neighbor(cc):
    nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 1, cc + 5, cc + 6, cc + 11]
    if cc % 11 == 0:
        nb = [cc - 11, cc - 5, cc + 1, cc + 6, cc + 11]
    if cc % 11 == 5:
        nb = [cc - 11, cc - 6, cc - 1, cc + 5, cc + 11]
    if cc % 11 == 6:
        nb = [cc - 11, cc - 6, cc - 5, cc + 1, cc + 5, cc + 6, cc + 11]
    if cc % 11 == 10:
        nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 5, cc + 6, cc + 11]
    return [x for x in nb if 0 <= x < N_CELLS]


NB = [find_neighbor(c) for c in range(N_CELLS)]


def islands(p):
    """Label groups of inserts connected through neighbours. Returns (labels, count, largest)."""
    lab, k, largest = [0] * N_CELLS, 0, 0
    for s in range(N_CELLS):
        if p[s] and not lab[s]:
            k += 1
            stack, lab[s], m = [s], k, 0
            while stack:
                u = stack.pop()
                m += 1
                for q in NB[u]:
                    if p[q] and not lab[q]:
                        lab[q] = k
                        stack.append(q)
            largest = max(largest, m)
    return lab, k, largest


def buckling_events(force, frac=0.015):
    """Number of force drops larger than frac * peak force (a drop counts once; the next one can
    only start after the force has recovered above the previous maximum)."""
    thr, n, peak, armed = frac * max(force), 0, force[0], True
    for v in force[1:]:
        if armed:
            if v > peak:
                peak = v
            elif peak - v > thr:
                n, armed = n + 1, False
        elif v > peak:
            peak, armed = v, True
    return n


def conforms(p):
    lab, k = [0] * N_CELLS, 0
    for s in range(N_CELLS):
        if p[s] and not lab[s]:
            k += 1
            stack, lab[s] = [s], k
            while stack:
                u = stack.pop()
                for q in NB[u]:
                    if p[q] and not lab[q]:
                        lab[q] = k
                        stack.append(q)
    return all(len({lab[q] for q in NB[z] if lab[q]}) >= 2 for z in range(N_CELLS) if not p[z])


# ---- loading
def load_patterns(path):
    a = np.load(path, allow_pickle=False)
    if a.ndim == 1:                                      # codeList: 105-digit strings
        codes = [[int(ch) for ch in str(s)] for s in a]
        M = np.zeros((len(codes), 19, 11), np.uint8)
        for i, p in enumerate(codes):
            if len(p) != N_CELLS:
                raise SystemExit("%s row %d: %d digits, expected 105" % (path, i, len(p)))
            for k, (r, c) in enumerate(RC):
                M[i, r, c] = p[k]
        return M, codes
    if a.shape[1:] != (19, 11):
        raise SystemExit("%s: shape %s, expected N x 19 x 11 or N strings" % (path, a.shape))
    M = (a > 0.5).astype(np.uint8)
    return M, [[int(M[i, r, c]) for r, c in RC] for i in range(len(M))]


EXPLORER_POINTS = 50


def write_explorer(out, codes, D, X, island):
    """Compact copy for the page's data-set explorer: explorer.bin + explorer.json.
    Per run: pattern (14 bytes, 105 bits in code order), displacement at 20 N (float32),
    50-point force curve (uint8, F = v / 250 * 21 - 0.5 N) and five metrics (uint8):
    inserts, islands, largest island, buckling events, follows the island algorithm."""
    n = len(codes)
    pat = np.packbits(np.array(codes, np.uint8), axis=1)                       # n x 14
    F = (D.astype(np.float64) + 1) * 10
    idx = np.round(np.linspace(0, D.shape[1] - 1, EXPLORER_POINTS)).astype(int)
    cur = np.clip(np.round((F[:, idx] + 0.5) / 21 * 250), 0, 255).astype(np.uint8)
    met = np.zeros((n, 5), np.uint8)
    for i, p in enumerate(codes):
        _, k, L = islands(p)
        met[i] = (sum(p), k, L, min(255, buckling_events(F[i])), island[i])
    parts = [("patterns", pat), ("max_displacement_mm", X.astype("<f4")), ("curves", cur), ("metrics", met)]
    head, off, blob = {"n": n, "curve_points": EXPLORER_POINTS, "force_from_byte": "v / 250 * 21 - 0.5",
                       "metric_names": ["inserts", "islands", "largest_island", "buckling_events", "island_algorithm"]}, 0, b""
    for name, arr in parts:
        b = np.ascontiguousarray(arr).tobytes()
        pad = (-off) % 4
        blob += b"\0" * pad
        off += pad
        head[name] = {"offset": off, "bytes": len(b), "shape": list(arr.shape), "dtype": str(arr.dtype)}
        blob += b
        off += len(b)
    with open(os.path.join(out, "explorer.bin"), "wb") as f:
        f.write(blob)
    with open(os.path.join(out, "explorer.json"), "w") as f:
        json.dump(head, f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", nargs=3, action="append", required=True, metavar=("PATTERNS", "DATADATA", "MAXDATA"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "docs", "data"))
    ap.add_argument("--exclude", help="challenge targets file (from make_challenge.py, kept outside the repository): "
                                      "these patterns are left out so they cannot be looked up")
    a = ap.parse_args()

    Ms, Ds, Xs, codes, sets = [], [], [], [], []
    for cp, dp, mp in a.set:
        M, c = load_patterns(cp)
        D = np.load(dp, allow_pickle=False).astype(np.float32)
        X = np.load(mp, allow_pickle=False).astype(np.float64).reshape(-1)
        if not (len(M) == len(D) == len(X)):
            raise SystemExit("rows differ in set %s: %d patterns, %d curves, %d displacements" % (cp, len(M), len(D), len(X)))
        if D.ndim != 2 or D.shape[1] != 200:
            raise SystemExit("%s: shape %s, expected N x 200" % (dp, D.shape))
        Ms.append(M); Ds.append(D); Xs.append(X)
        sets.append({"files": [os.path.basename(cp), os.path.basename(dp), os.path.basename(mp)], "rows_in_files": len(M),
                     "first": len(codes)})
        codes += c
        print("%s: %d runs" % (cp, len(M)))

    M, D, X = np.concatenate(Ms), np.concatenate(Ds), np.concatenate(Xs)
    # each pattern appears once: keep its first occurrence (earlier --set files take priority)
    keys = ["".join(map(str, p)) for p in codes]
    first = {}
    for i, k in enumerate(keys):
        first.setdefault(k, i)
    keep = np.array(sorted(first.values()))
    if len(keep) < len(keys):
        print("removed %d repeated patterns (kept the first occurrence)" % (len(keys) - len(keep)))
    for k, st in enumerate(sets):                       # how many rows each set contributed after removing repeats
        end = sets[k + 1]["first"] if k + 1 < len(sets) else len(keys)
        st["runs_added"] = int(((keep >= st.pop("first")) & (keep < end)).sum())
    M, D, X, codes = M[keep], D[keep], X[keep], [codes[i] for i in keep]
    held = 0
    if a.exclude:
        secret = {t["pattern"] for t in json.load(open(a.exclude))["targets"]}
        stay = np.array(["".join(map(str, p)) not in secret for p in codes])
        held = int((~stay).sum())
        M, D, X, codes = M[stay], D[stay], X[stay], [c for c, k in zip(codes, stay) if k]
        print("held out %d challenge targets" % held)
    island = np.array([conforms(p) for p in codes], np.uint8)
    os.makedirs(a.out, exist_ok=True)
    np.save(os.path.join(a.out, "codeData.npy"), M)
    np.save(os.path.join(a.out, "dataData.npy"), D)
    np.save(os.path.join(a.out, "maxData.npy"), X)
    np.save(os.path.join(a.out, "island.npy"), island)
    # pattern keys (105-digit code as 27 hex digits), so the page can skip queue runs of patterns already here
    with open(os.path.join(a.out, "keys.txt"), "w") as f:
        f.write("\n".join(format(int("".join(map(str, p)), 2), "027x") for p in codes) + "\n")
    write_explorer(a.out, codes, D, X, island)
    summary = {"runs": int(len(M)), "island": int(island.sum()), "other": int(len(M) - island.sum()),
               "built": date.today().isoformat(), "sets": sets, "held_out_targets": held}
    try:                                    # keep the descriptions written into an earlier summary.json
        old = {tuple(st["files"]): st.get("description") for st in json.load(open(os.path.join(a.out, "summary.json")))["sets"]}
        for st in sets:
            if old.get(tuple(st["files"])):
                st["description"] = old[tuple(st["files"])]
    except (OSError, ValueError, KeyError):
        pass
    with open(os.path.join(a.out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary))
    print("written to", os.path.abspath(a.out))


if __name__ == "__main__":
    main()
