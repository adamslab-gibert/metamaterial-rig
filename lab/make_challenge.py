"""Choose the inverse-design challenge targets from the web data set.

Picks N measured runs with at least two buckling events (force drops of more than 1.5 % of the
peak force), spread over the displacement at 20 N, and writes:

  --public  docs/data/challenge.json            target curves only (no patterns) -> published
  --secret  <a file OUTSIDE the repository>      the targets' patterns -> keep in the lab

Then rebuild the web data set without the targets so their patterns are not downloadable:
  python lab/build_web_dataset.py --exclude <secret file> --set ... --set ...

Usage:
  python lab/make_challenge.py --data docs/data --n 10 --public docs/data/challenge.json \
                               --secret C:/lab_private/challenge_targets_SECRET.json
"""
import argparse
import json
import os
from datetime import date

import numpy as np

from build_web_dataset import RC, buckling_events

FLIM = 20.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="docs/data")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--n-other", type=int, default=2, help="how many targets from patterns that do not follow the island algorithm")
    ap.add_argument("--min-events", type=int, default=2)
    ap.add_argument("--public", required=True)
    ap.add_argument("--secret", required=True)
    a = ap.parse_args()
    if os.path.abspath(a.secret).startswith(os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))):
        raise SystemExit("The secret file must be outside the repository.")

    C = np.load(os.path.join(a.data, "codeData.npy"))
    D = np.load(os.path.join(a.data, "dataData.npy")).astype(np.float64)
    M = np.load(os.path.join(a.data, "maxData.npy"))
    I = np.load(os.path.join(a.data, "island.npy"))
    ev = np.array([buckling_events((d + 1) * FLIM / 2) for d in D])

    picks = []
    for want_island, k in ((1, a.n - a.n_other), (0, a.n_other)):
        cand = np.where((ev >= a.min_events) & (I == want_island))[0]
        cand = cand[np.argsort(M[cand], kind="stable")]
        # spread over the displacement at 20 N: one run near each quantile
        q = (np.arange(k) + 0.5) / k
        picks += [int(cand[min(len(cand) - 1, int(round(x * (len(cand) - 1))))]) for x in q]
    picks.sort(key=lambda i: M[i])

    public, secret = [], []
    for t, i in enumerate(picks, 1):
        code = "".join(str(int(C[i, r, c])) for r, c in RC)
        tid = "T%d" % t
        public.append({"id": tid, "max_displacement_mm": round(float(M[i]), 3), "buckling_events": int(ev[i]),
                       "dataData": [round(float(v), 4) for v in D[i]]})
        secret.append({"id": tid, "pattern": code, "row_in_web_data_before_holdout": i,
                       "follows_island_algorithm": bool(I[i]), "inserts": code.count("1")})
    note = ("Score = RMS difference between the 200-point curves of the submitted pattern and the target, in N "
            "(F = (dataData + 1) * 10 N at the same fraction of each run's displacement at 20 N). "
            "The difference in displacement at 20 N is reported alongside. Lower is better.")
    with open(a.public, "w") as f:
        json.dump({"created": date.today().isoformat(), "scoring": note, "targets": public}, f)
    os.makedirs(os.path.dirname(os.path.abspath(a.secret)), exist_ok=True)
    with open(a.secret, "w") as f:
        json.dump({"created": date.today().isoformat(), "targets": secret}, f, indent=1)
    for p, s in zip(public, secret):
        print("%s  20 N at %5.1f mm  %d buckling events  %s" % (p["id"], p["max_displacement_mm"], p["buckling_events"],
                                                               "island" if s["follows_island_algorithm"] else "other"))
    print("public:", a.public, "\nsecret:", a.secret)


if __name__ == "__main__":
    main()
