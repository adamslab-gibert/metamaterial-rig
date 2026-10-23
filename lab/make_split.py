"""Standard training / validation / test split for the benchmark (Challenge page).

The data set's rows never change order (new runs are only appended), so row numbers are a stable handle.
Rows are split in blocks of 10,000: each block is shuffled once with a fixed seed and divided into
7,500 training, 1,250 validation and 1,250 test rows. The benchmark is the first K full blocks:
"20k" = rows 0-19,999, "30k" = rows 0-29,999, ... A row's role never changes when the benchmark grows.

Writes docs/data/split/benchmark_<N>k/{train,validation,test}.txt (one row number per line, sorted)
and docs/data/split/index.json (the versions available). Run again whenever the data set passes
the next multiple of 10,000 rows:  python lab/make_split.py
"""
import json
import os
import random

BLOCK, SEED = 10_000, 2026
TRAIN, VAL = 7_500, 1_250                  # per block; the remaining 1,250 are test rows
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "docs", "data")


def block_split(b):
    rows = list(range(b * BLOCK, (b + 1) * BLOCK))
    random.Random(SEED + b).shuffle(rows)
    return sorted(rows[:TRAIN]), sorted(rows[TRAIN:TRAIN + VAL]), sorted(rows[TRAIN + VAL:])


def main():
    n = json.load(open(os.path.join(DATA, "summary.json")))["runs"]
    blocks = n // BLOCK
    if blocks < 1:
        raise SystemExit("fewer than %d runs; no benchmark yet" % BLOCK)
    versions = []
    for k in range(2, blocks + 1):            # the first benchmark is 20k
        tr, va, te = [], [], []
        for b in range(k):
            a, c, d = block_split(b)
            tr += a; va += c; te += d
        name = "benchmark_%dk" % (k * BLOCK // 1000)
        out = os.path.join(DATA, "split", name)
        os.makedirs(out, exist_ok=True)
        for fname, rows in (("train.txt", tr), ("validation.txt", va), ("test.txt", te)):
            with open(os.path.join(out, fname), "w") as f:
                f.write("\n".join(map(str, sorted(rows))) + "\n")
        versions.append({"name": name, "rows": k * BLOCK, "train": len(tr), "validation": len(va), "test": len(te)})
        print("%s: rows 0-%d, %d train, %d validation, %d test" % (name, k * BLOCK - 1, len(tr), len(va), len(te)))
    with open(os.path.join(DATA, "split", "index.json"), "w") as f:
        json.dump({"block": BLOCK, "seed": SEED, "per_block": {"train": TRAIN, "validation": VAL, "test": BLOCK - TRAIN - VAL},
                   "current": versions[-1]["name"], "versions": versions}, f, indent=1)


if __name__ == "__main__":
    main()
