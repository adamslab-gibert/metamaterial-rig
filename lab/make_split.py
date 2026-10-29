"""Standard training / validation / test split for the inverse design benchmark (Challenge page).

The benchmark uses only runs that follow the ISLAND ALGORITHM. Those runs are taken in data-set row
order and split in blocks of 10,000: each block is shuffled once with a fixed seed and divided into
7,500 training, 1,250 validation and 1,250 test rows. The benchmark is the first K full blocks:
"20k" = the first 20,000 island runs, "30k" = the first 30,000, and so on. New runs are only ever
appended to the data set, so a row's role never changes when the benchmark grows.

Runs that do not follow the island algorithm (random insert placement) stay in the full data set and
are listed in other_patterns.txt, but they are not part of the benchmark.

Writes docs/data/split/benchmark_<N>k/{train,validation,test}.txt (one data-set row number per line,
sorted), docs/data/split/other_patterns.txt and docs/data/split/index.json. Run again whenever the
number of island runs passes the next multiple of 10,000:  python lab/make_split.py
"""
import json
import os
import random

import numpy as np

BLOCK, SEED = 10_000, 2026
TRAIN, VAL = 7_500, 1_250                  # per block; the remaining 1,250 are test rows
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "docs", "data")


def block_split(rows, b):
    """The rows of block b (10,000 island runs), shuffled once with a fixed seed and divided."""
    part = list(rows[b * BLOCK:(b + 1) * BLOCK])
    random.Random(SEED + b).shuffle(part)
    return sorted(part[:TRAIN]), sorted(part[TRAIN:TRAIN + VAL]), sorted(part[TRAIN + VAL:])


def main():
    island = np.load(os.path.join(DATA, "island.npy"))
    rows = [int(i) for i in np.where(island == 1)[0]]          # data-set rows that follow the island algorithm
    other = [int(i) for i in np.where(island == 0)[0]]
    blocks = len(rows) // BLOCK
    print("%d runs, %d follow the island algorithm, %d do not" % (len(island), len(rows), len(other)))
    if blocks < 2:
        raise SystemExit("fewer than %d island runs; no benchmark yet" % (2 * BLOCK))
    out_dir = os.path.join(DATA, "split")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "other_patterns.txt"), "w") as f:
        f.write("\n".join(map(str, other)) + "\n")
    versions = []
    for k in range(2, blocks + 1):            # the first benchmark is 20k
        tr, va, te = [], [], []
        for b in range(k):
            a, c, d = block_split(rows, b)
            tr += a; va += c; te += d
        name = "benchmark_%dk" % (k * BLOCK // 1000)
        out = os.path.join(out_dir, name)
        os.makedirs(out, exist_ok=True)
        for fname, part in (("train.txt", tr), ("validation.txt", va), ("test.txt", te)):
            with open(os.path.join(out, fname), "w") as f:
                f.write("\n".join(map(str, sorted(part))) + "\n")
        versions.append({"name": name, "rows": k * BLOCK, "train": len(tr), "validation": len(va), "test": len(te),
                         "last_row": max(tr + va + te)})
        print("%s: the first %s island runs (up to data-set row %d), %d train, %d validation, %d test"
              % (name, format(k * BLOCK, ","), max(tr + va + te), len(tr), len(va), len(te)))
    with open(os.path.join(out_dir, "index.json"), "w") as f:
        json.dump({"block": BLOCK, "seed": SEED, "island_only": True, "island_runs": len(rows),
                   "other_runs": len(other),
                   "per_block": {"train": TRAIN, "validation": VAL, "test": BLOCK - TRAIN - VAL},
                   "current": versions[-1]["name"], "versions": versions}, f, indent=1)


if __name__ == "__main__":
    main()
