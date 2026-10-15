"""Lab agent: links the rig computer to the public queue on GitHub.

It only makes outgoing HTTPS requests to api.github.com. It never controls hardware: it
exchanges small files with the rig program through a local folder (queue_dir):

  queue_dir/rig_status.json    written by the rig program every few seconds (state, accepting, job)
  queue_dir/accepting          present = the rig may take web jobs (created by `agent.py resume`)
  queue_dir/pause_message.txt  optional note shown on the web page while paused
  queue_dir/inbox/<n>.json     a job for the rig: {"issue": n, "pattern": "0101..."}
                               (a batch request runs one job per pattern; each gets its own number
                               BATCH_BASE + request*1000 + index, so the rig program needs no change)
  queue_dir/running/<n>.json   the job the rig is running now (moved there by the rig program)
  queue_dir/outbox/<n>/        results written by the rig: code.txt, data.txt, images/, done.json (last)
  queue_dir/archive/<n>/       results after they were published

Usage
  python agent.py run              keep running (status every 2 min, queue every 20 s)
  python agent.py once             one cycle, then exit (for testing)
  python agent.py pause ["note"]   stop taking new web jobs (the current one finishes)
  python agent.py resume           take web jobs again
  python agent.py status           print what the agent sees locally

Settings come from agent_config.json next to this file (see agent_config.example.json).
The GitHub token is read from the environment variable named in token_env (never from the repo).
"""
import base64
import csv
import io
import json
import logging
import os
import shutil
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
N_CELLS = 105
FLIM = 20.0
NPTS = 200
log = logging.getLogger("rig-agent")


# ------------------------------------------------------------------ pattern helpers
MAX_BATCH = 100
BATCH_BASE = 10_000_000          # job numbers of batch patterns: BATCH_BASE + request * 1000 + index


def section(body, name):
    """Text under the issue-form heading that starts with `name` (case-insensitive), or ''."""
    for part in ("\n" + (body or "")).split("\n### ")[1:]:
        head, _, text = part.partition("\n")
        if head.strip().lower().startswith(name.lower()):
            text = text.strip()
            return "" if text == "_No response_" else text
    return ""


def challenge_score(sub_dataData, sub_max, target):
    """Paper's 200-point error: RMS difference of the two normalised curves in N
    (F = (dataData + 1) * 10 N at the same fraction of each run's stroke), plus the
    difference in displacement at 20 N (submitted - target, mm)."""
    a, b = sub_dataData, target["dataData"]
    n = min(len(a), len(b))
    rms = (sum(((a[k] - b[k]) * FLIM / 2) ** 2 for k in range(n)) / n) ** 0.5
    return round(rms, 4), round(sub_max - target["max_displacement_mm"], 3)


def parse_batch(body):
    """Same rules as parseBatch in .github/scripts/validate.js. Returns (codes, None) or (None, reason).
    One pattern per line in index order, as 105 digits or as 27 hex digits."""
    if not body:
        return None, "The request is empty."
    sections = body.split("\n### ")
    if body.startswith("### "):
        sections[0] = sections[0][4:]
    sec = next((x for x in sections if x.lower().startswith("patterns")), None)
    if sec is None:
        return None, "The request has no Patterns field."
    lines = [l.strip() for l in sec.split("\n")[1:]]
    lines = [l for l in lines if l and l != "_No response_" and not l.startswith("```")]
    if not lines:
        return None, "The Patterns field is empty."
    if len(lines) > MAX_BATCH:
        return None, "The request has %d patterns; at most %d per request." % (len(lines), MAX_BATCH)
    codes = []
    for k, l in enumerate(lines):
        l = "".join(ch for ch in l if ch not in " \t\r,")
        if len(l) == N_CELLS and not set(l) - set("01"):
            codes.append(l)
        elif len(l) == 27 and l[0] in "01" and not set(l.lower()) - set("0123456789abcdef"):
            codes.append(format(int(l, 16), "0%db" % N_CELLS))
        else:
            return None, "Pattern %d (line %d) is not a valid pattern." % (k, k + 1)
    return codes, None

def parse_pattern(body):
    """Same rules as .github/scripts/validate.js. Returns (code, None) or (None, reason)."""
    if not body:
        return None, "The request is empty."
    sections = [s for s in body.split("\n### ")]
    if body.startswith("### "):
        sections[0] = sections[0][4:]
    sec = next((s for s in sections if s.lower().startswith("pattern")), None)
    text = sec.split("\n", 1)[1] if sec and "\n" in sec else body
    block = text.strip().split("\n\n")[0] if text.strip() else ""
    cleaned = "".join(ch for ch in block if ch not in " \t\r\n,")
    if not cleaned:
        return None, "The pattern field is empty."
    if set(cleaned) - set("01"):
        return None, "The pattern may only contain 0 and 1."
    if len(cleaned) != N_CELLS:
        return None, "The pattern has %d digits; it needs exactly %d." % (len(cleaned), N_CELLS)
    return cleaned, None


INDEX_HEADER = "issue,batch_index,tested_at,max_displacement_mm,status,pattern\n"
ADDITIONS_HEADER = "issue,tested_at,max_displacement_mm,pattern,dataData_200_values_space_separated\n"


def code_to_matrix(code):
    """105-digit code (bottom row first) -> 19 x 11 list, row 0 = top (codeData convention)."""
    M = [[0] * 11 for _ in range(19)]
    p = 0
    for r in range(18, -1, -1):
        for c in (range(0, 11, 2) if r % 2 == 0 else range(1, 10, 2)):
            M[r][c] = int(code[p])
            p += 1
    return M


def process_curve(E, F):
    """Raw rig readings -> data-set convention (same rules as the published data set).
    Loading part only; offset F0 = median reading in the first 0.1 mm; cut where F - F0 reaches 20 N."""
    j = max(range(len(E)), key=lambda k: E[k])
    E, F = E[: j + 1], F[: j + 1]
    F0 = statistics.median([f for e, f in zip(E, F) if e <= E[0] + 0.1])
    Fc = [f - F0 for f in F]
    k = next((i for i, f in enumerate(Fc) if f >= FLIM), None)
    if k is None or k == 0:
        if max(Fc) >= FLIM - 0.2:              # stopped just short of 20 N: keep up to the peak
            jp = max(range(len(Fc)), key=lambda i: Fc[i])
            Ec, Fk, status = E[: jp + 1], Fc[: jp + 1], "ok"
        else:
            Ec, Fk, status = E, Fc, "below 20 N"
    else:
        ec = E[k - 1] + (FLIM - Fc[k - 1]) / (Fc[k] - Fc[k - 1]) * (E[k] - E[k - 1])
        Ec, Fk, status = E[:k] + [ec], Fc[:k] + [FLIM], "ok"
    stroke = Ec[-1] - Ec[0]
    xs = [(e - Ec[0]) / stroke for e in Ec] if stroke > 0 else [0.0] * len(Ec)
    pts = sorted(dict(zip(xs, Fk)).items())            # unique, increasing
    xq = [i / (NPTS - 1) for i in range(NPTS)]
    Fi = [interp(x, pts) for x in xq]
    return {"status": status, "offset_N": F0, "max_displacement_mm": stroke,
            "displacement_mm": [x * stroke for x in xq], "force_N": Fi,
            "dataData": [2 * f / FLIM - 1 for f in Fi]}


def interp(x, pts):
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y1
    return pts[-1][1]


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json_atomic(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, path)


# ------------------------------------------------------------------ GitHub client
class GitHub:
    def __init__(self, owner, repo, token, branch="main"):
        self.owner, self.repo, self.branch = owner, repo, branch
        self.s = requests.Session()
        self.s.headers.update({"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rig-agent"})
        self.base = "https://api.github.com/repos/%s/%s" % (owner, repo)

    def req(self, method, path, ok=(200, 201, 204), **kw):
        url = path if path.startswith("http") else self.base + path
        for attempt in range(4):
            try:
                r = self.s.request(method, url, timeout=30, **kw)
            except requests.RequestException as e:
                log.warning("network error (%s), retrying", e)
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code in ok:
                return r.json() if r.content else None
            if r.status_code in (403, 429, 500, 502, 503) and attempt < 3:
                wait = int(r.headers.get("retry-after", 10 * (attempt + 1)))
                log.warning("GitHub %s on %s %s, waiting %ss", r.status_code, method, path, wait)
                time.sleep(wait)
                continue
            raise RuntimeError("GitHub %s on %s %s: %s" % (r.status_code, method, path, r.text[:300]))
        raise RuntimeError("GitHub unreachable for %s %s" % (method, path))

    def issues(self, **params):
        out, page = [], 1
        while True:
            batch = self.req("GET", "/issues", params=dict(params, per_page=100, page=page))
            out += [i for i in batch if "pull_request" not in i]
            if len(batch) < 100:
                return out
            page += 1

    def labels_of(self, issue):
        return {l["name"] for l in issue.get("labels", [])}

    def add_labels(self, n, labels):
        self.req("POST", "/issues/%d/labels" % n, json={"labels": list(labels)})

    def remove_label(self, n, label):
        self.req("DELETE", "/issues/%d/labels/%s" % (n, label), ok=(200, 204, 404))

    def comment(self, n, body):
        self.req("POST", "/issues/%d/comments" % n, json={"body": body})

    def edit_issue(self, n, **fields):
        return self.req("PATCH", "/issues/%d" % n, json=fields)

    def create_issue(self, title, body, labels):
        return self.req("POST", "/issues", json={"title": title, "body": body, "labels": labels})

    def lock(self, n):
        self.req("PUT", "/issues/%d/lock" % n, ok=(200, 204, 403, 422), json={"lock_reason": "resolved"})

    def ensure_label(self, name, color, description):
        self.req("POST", "/labels", ok=(201, 422), json={"name": name, "color": color, "description": description})

    def file_text(self, path):
        """Text of a file on the branch, or None if it does not exist. Uses the raw media type,
        which works for files up to 100 MB (the JSON form stops returning content above 1 MB)."""
        for attempt in range(4):
            try:
                r = self.s.get(self.base + "/contents/%s" % path, params={"ref": self.branch}, timeout=60,
                               headers={"Accept": "application/vnd.github.raw"})
            except requests.RequestException as e:
                log.warning("network error (%s), retrying", e)
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 404:
                return None
            if r.status_code == 200:
                return r.content.decode("utf-8")
            if r.status_code in (403, 429, 500, 502, 503) and attempt < 3:
                time.sleep(int(r.headers.get("retry-after", 10 * (attempt + 1))))
                continue
            raise RuntimeError("GitHub %s reading %s: %s" % (r.status_code, path, r.text[:300]))
        raise RuntimeError("GitHub unreachable reading %s" % path)

    def commit_files(self, files, message):
        """Add or replace several files in one commit. files: {path: bytes}."""
        for attempt in range(4):
            ref = self.req("GET", "/git/ref/heads/%s" % self.branch)
            head = ref["object"]["sha"]
            base_tree = self.req("GET", "/git/commits/%s" % head)["tree"]["sha"]
            tree = []
            for path, data in files.items():
                blob = self.req("POST", "/git/blobs", json={"content": base64.b64encode(data).decode(), "encoding": "base64"})
                tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
            new_tree = self.req("POST", "/git/trees", json={"base_tree": base_tree, "tree": tree})
            commit = self.req("POST", "/git/commits", json={"message": message, "tree": new_tree["sha"], "parents": [head]})
            try:
                self.req("PATCH", "/git/refs/heads/%s" % self.branch, json={"sha": commit["sha"]})
                return commit["sha"]
            except RuntimeError as e:          # someone pushed in between: rebuild on the new head
                log.warning("branch moved, retrying commit (%s)", e)
        raise RuntimeError("could not commit results")

    def blob_url(self, path):
        return "https://github.com/%s/%s/blob/%s/%s" % (self.owner, self.repo, self.branch, path)

    def tree_url(self, path):
        return "https://github.com/%s/%s/tree/%s/%s" % (self.owner, self.repo, self.branch, path)


# ------------------------------------------------------------------ the agent
STATUS_TITLE = "Machine status (updated automatically)"
STATUS_TEXT = {"ready": "Online and ready", "busy": "Running a test", "paused": "Online, not taking new tests",
               "offline": "Offline"}


class Agent:
    def __init__(self, cfg, gh):
        self.cfg, self.gh = cfg, gh
        q = Path(cfg["queue_dir"])
        self.q = q
        for d in ("inbox", "running", "outbox", "archive"):
            (q / d).mkdir(parents=True, exist_ok=True)
        self.state_file = q / "agent_state.json"
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        self.state.setdefault("current", None)
        self.state.setdefault("durations_min", [])
        self.status_issue = None
        self.last_published = (None, 0.0)

    def save_state(self):
        write_json_atomic(self.state_file, self.state)

    # ---- what the rig program reports
    def rig_status(self):
        f = self.q / "rig_status.json"
        try:
            s = json.loads(f.read_text())
        except (OSError, ValueError):
            return None
        if time.time() - float(s.get("time", 0)) > self.cfg.get("rig_stale_seconds", 60):
            return None
        return s

    def public_state(self, rig):
        s = self._public_state(rig)
        s["last"] = self.state.get("last_result")       # the page shows its pattern and curve
        return s

    def _public_state(self, rig):
        queue = len(self._queued_cache) if hasattr(self, "_queued_cache") else None
        per = self.minutes_per_test()
        if rig is None:
            return {"state": "offline", "message": "The rig program is not running.", "job": None, "queue": queue, "minutes_per_test": per}
        if rig.get("state") == "busy" or self.state["current"]:
            job = rig.get("job") or self.state["current"]
            s = {"state": "busy", "message": "", "job": job, "queue": queue, "minutes_per_test": per}
            s["pattern"] = self.state.get("current_pattern")
            nk = self.state.get("jobs", {}).get(str(job))
            b = self.state.get("batch")
            if nk:
                s["job"] = nk[0]
                s["batch_index"] = nk[1]
                s["batch_total"] = len(b["codes"]) if b and b["issue"] == nk[0] else None
            return s
        note_file = self.q / "pause_message.txt"
        note = note_file.read_text().strip() if note_file.exists() else ""
        if rig.get("state") == "error":
            return {"state": "paused", "message": note or "The last test stopped with an error; a lab member will check the machine.", "job": None, "queue": queue, "minutes_per_test": per}
        if not rig.get("hardware_ready", True):
            return {"state": "paused", "message": note or "The machine is switched on but not set up for testing yet.", "job": None, "queue": queue, "minutes_per_test": per}
        if not rig.get("accepting"):
            return {"state": "paused", "message": note or "The lab has paused the queue. Submitted patterns keep their place.", "job": None, "queue": queue, "minutes_per_test": per}
        return {"state": "ready", "message": "", "job": None, "queue": queue, "minutes_per_test": per}

    def minutes_per_test(self):
        d = self.state["durations_min"][-20:]
        return round(statistics.median(d), 1) if d else None

    # ---- status issue on GitHub
    def find_status_issue(self):
        if self.status_issue:
            return self.status_issue
        found = self.gh.issues(state="open", labels="machine-status")
        if found:
            self.status_issue = found[0]["number"]
        else:
            self.gh.ensure_label("machine-status", "8A96A0", "Live status of the rig (updated by the lab computer)")
            body = self.status_body({"state": "offline", "message": "", "job": None, "updated": now_iso()})
            self.status_issue = self.gh.create_issue(STATUS_TITLE, body, ["machine-status"])["number"]
            self.gh.lock(self.status_issue)
        return self.status_issue

    def status_body(self, s):
        return ("The lab computer updates this issue automatically so the rig page can show whether the machine is "
                "available. Please don't comment here.\n\n**%s**%s\n\n```json\n%s\n```\n"
                % (STATUS_TEXT.get(s["state"], s["state"]),
                   (": " + s["message"]) if s.get("message") else "", json.dumps(s, indent=1)))

    def publish(self, s):
        key = json.dumps({k: s.get(k) for k in ("state", "message", "job", "queue", "batch_index", "last")}, sort_keys=True)
        last_key, last_t = self.last_published
        if key == last_key and time.time() - last_t < self.cfg.get("heartbeat_seconds", 120):
            return
        s = dict(s, updated=now_iso())
        self.gh.edit_issue(self.find_status_issue(), body=self.status_body(s))
        self.last_published = (key, time.time())
        log.info("status: %s %s", s["state"], s.get("message") or "")

    # ---- queue
    def queued(self):
        items = self.gh.issues(state="open", labels="queued", sort="created", direction="asc")
        items = [i for i in items if not ({"running", "done", "failed", "invalid"} & self.gh.labels_of(i))]
        self._queued_cache = items
        return items

    def dispatch(self, rig):
        if self.state["current"] or any((self.q / "inbox").glob("*.json")) or any((self.q / "running").glob("*.json")):
            return
        if not (rig and rig.get("state") == "idle" and rig.get("accepting") and rig.get("hardware_ready", True)):
            return
        b = self.state.get("batch")
        if b and b["next"] < len(b["codes"]):          # a batch in progress runs to the end first
            self.dispatch_batch_pattern()
            return
        for issue in self.queued():
            n = issue["number"]
            if "batch-request" in self.gh.labels_of(issue):
                codes, why = parse_batch(issue.get("body"))
                if not codes:
                    self.gh.remove_label(n, "queued")
                    self.gh.add_labels(n, ["invalid"])
                    self.gh.comment(n, "**The rig could not read this batch.** %s Upload the zip on the rig page again." % why)
                    continue
                self.state["batch"] = {"issue": n, "codes": codes, "next": 0, "results": {},
                                       "submitted_by": issue["user"]["login"]}
                self.save_state()
                self.gh.remove_label(n, "queued")
                self.gh.add_labels(n, ["running"])
                self.gh.comment(n, "**Started on the rig.** The %d patterns are tested one after another in index order. "
                                   "You can watch on the live view; the results are posted here when the batch is finished." % len(codes))
                self.dispatch_batch_pattern()
                return
            code, why = parse_pattern(issue.get("body"))
            if not code:
                self.gh.remove_label(n, "queued")
                self.gh.add_labels(n, ["invalid"])
                self.gh.comment(n, "**The rig could not read this pattern.** %s Edit the request to fix it." % why)
                continue
            job = {"issue": n, "pattern": code, "submitted_by": issue["user"]["login"], "dispatched": now_iso()}
            write_json_atomic(self.q / "inbox" / ("%d.json" % n), job)
            self.state["current"] = n
            self.state["current_pattern"] = code
            self.state["started_" + str(n)] = time.time()
            self.save_state()
            self.gh.remove_label(n, "queued")
            self.gh.add_labels(n, ["running"])
            self.gh.comment(n, "**Started on the rig.** The robot is placing the inserts now. You can watch on the live view; results will be posted here.")
            log.info("dispatched #%d", n)
            return

    def dispatch_batch_pattern(self):
        b = self.state["batch"]
        n, k = b["issue"], b["next"]
        jid = BATCH_BASE + n * 1000 + k
        job = {"issue": jid, "pattern": b["codes"][k], "submitted_by": b["submitted_by"], "dispatched": now_iso(),
               "batch_request": n, "batch_index": k}
        write_json_atomic(self.q / "inbox" / ("%d.json" % jid), job)
        self.state.setdefault("jobs", {})[str(jid)] = [n, k]
        b["next"] = k + 1
        self.state["current"] = jid
        self.state["current_pattern"] = b["codes"][k]
        self.state["started_" + str(jid)] = time.time()
        self.save_state()
        log.info("dispatched #%d pattern %d of %d", n, k + 1, len(b["codes"]))

    # ---- results
    def collect(self):
        for done in sorted((self.q / "outbox").glob("*/done.json")):
            folder = done.parent
            n = int(folder.name)
            nk = self.state.get("jobs", {}).get(str(n))
            try:
                info = json.loads(done.read_text())
                if nk:
                    self.batch_result(nk[0], nk[1], folder, info)
                elif info.get("ok"):
                    self.publish_result(n, folder, info)
                else:
                    self.report_failure(n, info.get("message", "unknown reason"))
            except Exception as e:                      # keep the folder; try again next cycle
                log.exception("could not publish #%d: %s", n, e)
                continue
            target = self.q / "archive" / folder.name
            if target.exists():
                shutil.rmtree(target)
            shutil.move(str(folder), str(target))
            t0 = self.state.pop("started_" + str(n), None)
            if t0 and info.get("ok"):
                self.state["durations_min"].append((time.time() - t0) / 60)
            if self.state["current"] == n:
                self.state["current"] = None
                self.state["current_pattern"] = None
            if nk:
                self.state["jobs"].pop(str(n), None)
            self.save_state()
            if nk:
                self.finish_batch_if_done()

    def report_failure(self, n, message):
        self.gh.remove_label(n, "running")
        self.gh.add_labels(n, ["failed"])
        self.gh.comment(n, "**The test did not finish.** %s\n\nA lab member will look at it and can put the pattern back in the queue." % message)
        log.warning("#%d failed: %s", n, message)

    def result_files(self, n, folder, info, submitted_by, base, batch_index=None):
        """Files for one tested pattern (curve, raw data, photos, plot) plus its rows in
        results/index.csv and results/dataset_additions.csv. Returns (files, curve, photos, png)."""
        code = "".join(ch for ch in (folder / "code.txt").read_text() if ch in "01")
        E, F = [], []
        for line in (folder / "data.txt").read_text().splitlines():
            parts = line.replace("\t", ",").split(",")
            if len(parts) >= 2:
                E.append(float(parts[0]))
                F.append(float(parts[1]))
        curve = process_curve(E, F)
        frames = self.frames(folder / "images", E, F, curve)
        meta = {"issue": n, "batch_index": batch_index, "pattern": code, "pattern_matrix_19x11": code_to_matrix(code),
                "submitted_by": submitted_by, "tested_at": info.get("finished") or now_iso(),
                "license": "CC-BY-4.0", "frames": len(frames), **curve}
        files = {base + "curve.json": json.dumps(meta).encode(),
                 base + "pattern.txt": (code + "\n").encode(),
                 base + "raw.csv": ("displacement_mm,force_N\n" + "\n".join("%g,%g" % (e, f) for e, f in zip(E, F)) + "\n").encode()}
        for k, fr in enumerate(frames):
            files[base + "frames/frame_%02d.jpg" % k] = fr["jpg"]
        if frames:
            files[base + "frames.json"] = json.dumps([{"file": "frames/frame_%02d.jpg" % k, "displacement_mm": fr["u"],
                                                       "force_N": fr["f"]} for k, fr in enumerate(frames)]).encode()
        photos = [fr["jpg"] for fr in frames]
        png = self.plot(curve, n if batch_index is None else "%d, pattern %d" % (n, batch_index))
        if png:
            files[base + "curve.png"] = png
        idx = self.gh.file_text("results/index.csv") or INDEX_HEADER
        idx += "%d,%s,%s,%.3f,%s,%s\n" % (n, "" if batch_index is None else batch_index, meta["tested_at"],
                                          curve["max_displacement_mm"], curve["status"], code)
        files["results/index.csv"] = idx.encode()
        if curve["status"] == "ok":
            # one line per run in data-set form; the web page merges these into the download
            add = self.gh.file_text("results/dataset_additions.csv") or ADDITIONS_HEADER
            add += "%d,%s,%.4f,%s,%s\n" % (n, meta["tested_at"], curve["max_displacement_mm"], code,
                                           " ".join("%.5f" % v for v in curve["dataData"]))
            files["results/dataset_additions.csv"] = add.encode()
        self.state["last_result"] = {"issue": n, "batch_index": batch_index, "curve": base + "curve.json",
                                     "frames": (base + "frames.json") if frames else None, "pattern": code}
        return files, curve, photos, png

    def publish_result(self, n, folder, info):
        issue = self.gh.req("GET", "/issues/%d" % n)
        base = "results/%d/" % n
        files, curve, photos, png = self.result_files(n, folder, info, issue["user"]["login"], base)
        score_line = ""
        if "challenge" in self.gh.labels_of(issue):
            score_line = self.score_challenge(n, issue, curve, files)
        self.gh.commit_files(files, "Results for pattern request #%d" % n)

        lines = ["**Tested.** " + ("The force reached 20 N at **%.1f mm**." % curve["max_displacement_mm"]
                                   if curve["status"] == "ok" else "The force did not reach 20 N in the travel allowed.")]
        if score_line:
            lines.append("\n" + score_line)
        if png:
            lines.append("\n![Force against displacement](%s?raw=true)" % self.gh.blob_url(base + "curve.png"))
        if photos:
            lines.append("\n![Specimen during the test](%s?raw=true)" % self.gh.blob_url(base + "frames/frame_%02d.jpg" % (len(photos) - 1)))
        lines.append("\nFiles: [200-point curve (JSON)](%s), [raw readings (CSV)](%s), [all photos](%s). Published under CC BY 4.0."
                     % (self.gh.blob_url(base + "curve.json"), self.gh.blob_url(base + "raw.csv"), self.gh.tree_url(base)))
        self.gh.comment(n, "\n".join(lines))
        self.gh.remove_label(n, "running")
        self.gh.add_labels(n, ["done"])
        self.gh.edit_issue(n, state="closed", state_reason="completed")
        log.info("published #%d (%.1f mm)", n, curve["max_displacement_mm"])

    # ---- batches
    def batch_result(self, n, k, folder, info):
        """One pattern of a batch finished (or failed): publish its files and update results/<n>/batch.json."""
        b = self.state["batch"]
        base = "results/%d/" % n
        entry = {"index": k, "pattern": b["codes"][k]}
        files = {}
        if info.get("ok"):
            files, curve, _, _ = self.result_files(n, folder, info, b["submitted_by"], base + "%d/" % k, batch_index=k)
            entry.update(status=curve["status"], max_displacement_mm=round(curve["max_displacement_mm"], 3),
                         force_N=[round(v, 3) for v in curve["force_N"]], tested_at=info.get("finished") or now_iso())
        else:
            entry.update(status="failed", message=info.get("message", "unknown reason"))
            self.gh.comment(n, "**Pattern %d of this batch did not finish.** %s\n\nThe rest of the batch continues once a lab "
                               "member has checked the machine." % (k, entry["message"]))
        b["results"][str(k)] = entry
        summary = {"issue": n, "total": len(b["codes"]), "submitted_by": b["submitted_by"],
                   "patterns": [b["results"][str(i)] for i in range(len(b["codes"])) if str(i) in b["results"]]}
        files[base + "batch.json"] = json.dumps(summary).encode()
        self.gh.commit_files(files, "Results for batch request #%d, pattern %d" % (n, k))
        self.save_state()
        log.info("batch #%d: pattern %d %s", n, k, entry["status"])

    def finish_batch_if_done(self):
        b = self.state.get("batch")
        if not b or len(b["results"]) < len(b["codes"]):
            return
        n, rows = b["issue"], [b["results"][str(i)] for i in range(len(b["codes"]))]
        ok = [r for r in rows if r["status"] == "ok"]
        lines = ["**Batch finished: %d of %d patterns tested.**" % (len(ok), len(rows)), "",
                 "| Index | Inserts | 20 N reached at | Result |", "|---:|---:|---:|---|"]
        for r in rows:
            lines.append("| %d | %d | %s | %s |" % (r["index"], r["pattern"].count("1"),
                         "%.1f mm" % r["max_displacement_mm"] if r.get("max_displacement_mm") is not None else "–",
                         "ok" if r["status"] == "ok" else r.get("message") or r["status"]))
        lines.append("\nAll files (curves, raw readings, photos, plots) are in [results/%d](%s). Published under CC BY 4.0."
                     % (n, self.gh.tree_url("results/%d/" % n)))
        self.gh.comment(n, "\n".join(lines))
        self.gh.remove_label(n, "running")
        self.gh.add_labels(n, ["done"])
        self.gh.edit_issue(n, state="closed", state_reason="completed")
        self.state["batch"] = None
        self.save_state()
        log.info("batch #%d finished (%d/%d ok)", n, len(ok), len(rows))

    def frames(self, folder, E, F, curve):
        """All photos of the loading phase (up to max_frames), each with the displacement and force at
        the moment it was taken, in the same units as curve.json (offset removed, from the first reading)."""
        if not folder.exists():
            return []
        imgs = sorted(p for p in folder.glob("frame_*") if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
        if not imgs:
            return []
        F0, E0 = curve.get("offset_N", 0.0), E[0]
        stroke = curve["max_displacement_mm"]
        at = []                                          # reading index of each photo
        log = folder / "frames.csv"
        if log.exists():                                 # written by the rig program
            for row in log.read_text().splitlines()[1:]:
                parts = row.split(",")
                if len(parts) >= 2 and parts[1].strip().isdigit():
                    at.append(int(parts[1]))
        else:                                            # older rig program: replay its photo rule
            last_e, last_f = -1.0, -1.0
            for i in range(1, len(E)):
                if E[i] < E[i - 1] - 1e-9:
                    break                                # unloading started
                if E[i] - last_e >= 5.0 or F[i] - last_f >= 1.0:
                    last_e, last_f = E[i], F[i]
                    at.append(i)
        pairs = [(img, i) for img, i in zip(imgs, at) if 0 <= i < len(E) and E[i] - E0 <= stroke + 1e-6]
        k = self.cfg.get("max_frames", 40)
        if len(pairs) > k:
            pairs = [pairs[round(j * (len(pairs) - 1) / (k - 1))] for j in range(k)]
        out = []
        for img, i in pairs:
            jpg = self.shrink(img, self.cfg.get("frame_width", 720))
            out.append({"jpg": jpg, "u": round(E[i] - E0, 3), "f": round(min(F[i] - F0, FLIM), 3)})
        return out

    def shrink(self, path, width):
        try:
            from PIL import Image
            im = Image.open(path).convert("RGB")
            if im.width > width:
                im = im.resize((width, round(im.height * width / im.width)))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80)
            return buf.getvalue()
        except ImportError:
            return path.read_bytes()

    def score_challenge(self, n, issue, curve, files):
        """Score a challenge entry against its target and add it to results/leaderboard.json."""
        body = issue.get("body") or ""
        tid = section(body, "target").split()[0].strip(".:,") if section(body, "target") else ""
        method = section(body, "method")[:1500]
        try:
            targets = {t["id"]: t for t in json.loads(self.gh.file_text("docs/data/challenge.json"))["targets"]}
        except (TypeError, ValueError, KeyError):
            return "The challenge targets could not be read, so this entry was not scored; a lab member will check it."
        if tid not in targets:
            return "The target **%s** does not exist, so this entry was not scored." % (tid or "(none)")
        if curve["status"] != "ok":
            return "The force did not reach 20 N, so this entry could not be scored against **%s**." % tid
        score, dstroke = challenge_score(curve["dataData"], curve["max_displacement_mm"], targets[tid])
        board = json.loads(self.gh.file_text("results/leaderboard.json") or "[]")
        board = [e for e in board if e.get("issue") != n]
        board.append({"issue": n, "user": issue["user"]["login"], "target": tid, "score_N": score,
                      "stroke_error_mm": dstroke, "max_displacement_mm": round(curve["max_displacement_mm"], 3),
                      "tested_at": now_iso(), "method": method, "pattern": (self.state.get("last_result") or {}).get("pattern")})
        files["results/leaderboard.json"] = json.dumps(board, indent=1).encode()
        better = [e for e in board if e["target"] == tid and e["score_N"] < score]
        return ("**Challenge %s: score %.3f N** (RMS force difference of the 200-point curves; lower is better). "
                "The displacement at 20 N differs by %+.1f mm from the target. Current rank on %s: %d of %d."
                % (tid, score, dstroke, tid, len(better) + 1, len([e for e in board if e["target"] == tid])))

    def plot(self, curve, n):
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            return None
        fig, ax = plt.subplots(figsize=(5, 3.2), dpi=150)
        ax.plot(curve["displacement_mm"], curve["force_N"], color="#3256B0", lw=2)
        ax.set_xlabel("Displacement (mm)")
        ax.set_ylabel("Force (N)")
        ax.set_ylim(0, 21)
        ax.set_xlim(0, None)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.set_title("Pattern request #%s" % n, loc="left", fontsize=10)
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png")
        plt.close(fig)
        return buf.getvalue()

    # ---- one cycle
    def tick(self, publish_status=True):
        rig = self.rig_status()
        self.collect()
        try:
            self.queued()
        except RuntimeError as e:
            log.warning("could not read the queue: %s", e)
        self.dispatch(rig)
        if publish_status:
            self.publish(self.public_state(self.rig_status()))


# ------------------------------------------------------------------ command line
def load_config():
    path = HERE / "agent_config.json"
    if not path.exists():
        sys.exit("Copy agent_config.example.json to agent_config.json and fill it in.")
    return json.loads(path.read_text())


def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(HERE / "agent.log")])
    cfg = load_config()
    q = Path(cfg["queue_dir"])
    q.mkdir(parents=True, exist_ok=True)
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd == "pause":
        try:
            (q / "accepting").unlink()
        except FileNotFoundError:
            pass
        (q / "pause_message.txt").write_text(argv[2] if len(argv) > 2 else "")
        print("Paused: the rig finishes the current test and takes no new web jobs.")
        return
    if cmd == "resume":
        (q / "accepting").write_text("web jobs allowed\n")
        try:
            (q / "pause_message.txt").unlink()
        except FileNotFoundError:
            pass
        print("Resumed: the rig takes web jobs when it is idle.")
        return
    token = os.environ.get(cfg.get("token_env", "RIG_GITHUB_TOKEN"), "")
    if not token:
        sys.exit("Set the environment variable %s to the GitHub token." % cfg.get("token_env", "RIG_GITHUB_TOKEN"))
    agent = Agent(cfg, GitHub(cfg["owner"], cfg["repo"], token, cfg.get("branch", "main")))
    if cmd == "status":
        print(json.dumps({"rig": agent.rig_status(), "public": agent.public_state(agent.rig_status()),
                          "agent_state": agent.state}, indent=1))
        return
    if cmd == "once":
        agent.tick()
        return
    log.info("agent started for %s/%s, queue folder %s", cfg["owner"], cfg["repo"], q)
    while True:
        try:
            agent.tick()
        except Exception as e:                           # never die on a transient error
            log.exception("cycle failed: %s", e)
        time.sleep(cfg.get("poll_seconds", 20))


if __name__ == "__main__":
    main(sys.argv)
