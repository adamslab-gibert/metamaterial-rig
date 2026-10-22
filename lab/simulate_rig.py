"""Stand-in for the rig program, for testing the web queue without the machine.

It speaks the same folder protocol as the WEB QUEUE ADD-ON: writes rig_status.json, takes jobs
from inbox/, and writes outbox/<n>/ with code.txt, data.txt and done.json. The force curve is
replayed from the most similar pattern in the measured data set when the .npy files are given,
otherwise a made-up curve is used.

  python simulate_rig.py --queue-dir ./web_queue_test --seconds 20 [--data ../data]

Run agent.py against a test repository at the same time (queue_dir pointing to the same folder),
then submit patterns on the page and watch them go through.
"""
import argparse
import json
import math
import os
import random
import time
from pathlib import Path


def write_json(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, path)


def code_to_matrix_flat(code):
    M = [[0] * 11 for _ in range(19)]
    p = 0
    for r in range(18, -1, -1):
        for c in (range(0, 11, 2) if r % 2 == 0 else range(1, 10, 2)):
            M[r][c] = int(code[p])
            p += 1
    return M


class CurveSource:
    def __init__(self, data_dir):
        self.ok = False
        if not data_dir:
            return
        try:
            import numpy as np
            d = Path(data_dir)
            pick = lambda stem: next(p for p in [d / (stem + "_final.npy"), d / (stem + ".npy")] if p.exists())
            self.np = np
            self.C = np.load(pick("codeData")).reshape(-1, 19 * 11)
            self.D = np.load(pick("dataData"))
            self.M = np.load(pick("maxData")).ravel()
            self.ok = True
        except Exception as e:
            print("data set not loaded (%s); using made-up curves" % e)

    def curve(self, code):
        if self.ok:
            np = self.np
            q = np.array(code_to_matrix_flat(code), float).ravel()
            k = int(np.argmin(((self.C - q) ** 2).sum(1)))
            F = (self.D[k] + 1) * 10
            E = np.linspace(0, self.M[k], len(F))
            return list(E), list(F)
        n = code.count("1")
        s20 = 30 - 0.15 * n + random.uniform(-1, 1)
        E = [s20 * k / 199 for k in range(200)]
        F = [20 * (0.62 * math.tanh(2.6 * x / s20) + 0.38 * (x / s20) ** 4) / (0.62 * math.tanh(2.6) + 0.38) for x in E]
        return E, F


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue-dir", required=True)
    ap.add_argument("--seconds", type=float, default=20, help="how long one simulated test takes")
    ap.add_argument("--data", default="", help="folder with codeData/dataData/maxData .npy files")
    ap.add_argument("--fail-every", type=int, default=0, help="make every Nth job fail (to test failures)")
    a = ap.parse_args()
    q = Path(a.queue_dir)
    for d in ("inbox", "running", "outbox", "archive"):
        (q / d).mkdir(parents=True, exist_ok=True)
    src = CurveSource(a.data)
    job, count = None, 0

    def status(state):
        write_json(q / "rig_status.json", {"state": state, "job": job, "accepting": (q / "accepting").exists(),
                                           "hardware_ready": True, "message": "", "time": time.time()})

    print("simulated rig running; create %s to accept jobs" % (q / "accepting"))
    while True:
        status("idle")
        jobs = sorted((q / "inbox").glob("*.json"), key=os.path.getmtime)
        if jobs and (q / "accepting").exists():
            run = q / "running" / jobs[0].name
            os.replace(jobs[0], run)
            j = json.loads(run.read_text())
            job = j["issue"]
            count += 1
            print("running #%s" % job)
            t0 = time.time()
            while time.time() - t0 < a.seconds:
                status("busy")
                time.sleep(1)
            out = q / "outbox" / str(job)
            (out / "images").mkdir(parents=True, exist_ok=True)
            started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0))
            if a.fail_every and count % a.fail_every == 0:
                write_json(out / "done.json", {"ok": False, "message": "Simulated failure.", "started": started})
            else:
                E, F = src.curve(j["pattern"])
                off = random.uniform(-0.1, 0.1)
                lines = ["%.3f,%.4f" % (e, f + off) for e, f in zip(E, F)]
                lines += ["%.3f,%.4f" % (e, off) for e in reversed(E[::10])]          # unloading
                (out / "data.txt").write_text("\n".join(lines) + "\n")
                (out / "code.txt").write_text(j["pattern"])
                write_json(out / "done.json", {"ok": True, "message": "simulated", "started": started,
                                               "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            run.unlink()
            job = None
        time.sleep(2)


if __name__ == "__main__":
    main()
