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
import threading
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
AUTO_BASE = 20_000_000           # job numbers of automatic data-set patterns: AUTO_BASE + k (k = 1, 2, ...)


# ------------------------------------------------------------------ island rule and new patterns
def _find_neighbor(cc):          # identical to find_neighbor in the lab's island_generator.py
    nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 1, cc + 5, cc + 6, cc + 11]
    if cc % 11 == 0:
        nb = [cc - 11, cc - 5, cc + 1, cc + 6, cc + 11]
    if cc % 11 == 5:
        nb = [cc - 11, cc - 6, cc - 1, cc + 5, cc + 11]
    if cc % 11 == 6:
        nb = [cc - 11, cc - 6, cc - 5, cc + 1, cc + 5, cc + 6, cc + 11]
    if cc % 11 == 10:
        nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 5, cc + 6, cc + 11]
    return [x for x in nb if 0 <= x < 105]


ISLAND_NB = [_find_neighbor(c) for c in range(105)]


def conforms(p):
    """Island algorithm: every empty cell touches at least two different islands of inserts."""
    lab, k = [0] * 105, 0
    for s in range(105):
        if p[s] and not lab[s]:
            k += 1
            stack, lab[s] = [s], k
            while stack:
                u = stack.pop()
                for q in ISLAND_NB[u]:
                    if p[q] and not lab[q]:
                        lab[q] = k
                        stack.append(q)
    return all(len({lab[q] for q in ISLAND_NB[z] if lab[q]}) >= 2 for z in range(105) if not p[z])


def key_of(code):
    """27-hex-digit key of a 105-digit pattern (as in docs/data/keys.txt)."""
    return format(int(code, 2), "027x")


def island_pattern(K, rng):
    """One pattern from the island algorithm (same as the lab's island_generator.py):
    1. seeds: K random cells, none on or next to another seed;
    2. growth: pick a random open cell; touching one island -> joins it, touching two or more -> stays
       empty for good, touching none -> stays open; until no cell is open;
    3. island cells get an insert."""
    clusters, avail = [], [1] * 105
    for _ in range(K):
        while True:
            core = rng.randint(0, 104)
            if all(core != c[0] and core not in ISLAND_NB[c[0]] for c in clusters):
                clusters.append([core])
                avail[core] = 0
                break
    pool = [i for i, e in enumerate(avail) if e]
    while pool:
        t = rng.choice(pool)
        touch = [any(t in ISLAND_NB[u] for u in cl) for cl in clusters]
        if sum(touch) == 1:
            clusters[touch.index(True)].append(t)
            avail[t] = 0
        elif sum(touch) > 1:
            avail[t] = 0
        pool = [i for i, e in enumerate(avail) if e]
    p = [0] * 105
    for cl in clusters:
        for u in cl:
            p[u] = 1
    return p


def new_island_pattern(known_keys, rng=None, kmin=4, kmax=17):
    """A new pattern from the island algorithm (4 to 17 islands, chosen at random) that is not in known_keys
    (the data set and every run added since). Same method as the website's "Random island pattern" button."""
    import random
    rng = rng or random.Random()
    for _ in range(2000):
        p = island_pattern(rng.randint(kmin, kmax), rng)
        code = "".join(map(str, p))
        if conforms(p) and key_of(code) not in known_keys:
            return code
    return None


def section(body, name):
    """Text under the issue-form heading that starts with `name` (case-insensitive), or ''."""
    for part in ("\n" + (body or "")).split("\n### ")[1:]:
        head, _, text = part.partition("\n")
        if head.strip().lower().startswith(name.lower()):
            text = text.strip()
            return "" if text == "_No response_" else text
    return ""


def submitter_name(issue):
    """The name given in the request form ("Your name"), or the GitHub user name."""
    name = " ".join(section((issue or {}).get("body"), "your name").split())[:80]
    return name or ((issue or {}).get("user") or {}).get("login", "")


def challenge_score(sub_dataData, sub_max, target):
    """Paper's 200-point error: RMS difference of the two normalised curves in N
    (F = (dataData + 1) * 10 N at the same fraction of each run's stroke), plus the
    difference in displacement at 20 N (submitted - target, mm)."""
    a, b = sub_dataData, target["dataData"]
    n = min(len(a), len(b))
    rms = (sum(((a[k] - b[k]) * FLIM / 2) ** 2 for k in range(n)) / n) ** 0.5
    return round(rms, 4), round(sub_max - target["max_displacement_mm"], 3)


MAX_CHALLENGE_ENTRIES = 10


def parse_challenge_entries(body):
    """Challenge entries uploaded as a zip: lines "T3 <pattern>" under the Entries heading, the pattern as
    105 digits or 27 hex digits. At most one pattern per target. Same rules as validate.js.
    Returns ([(target, code), ...], None) or (None, reason)."""
    text = section(body, "entries")
    lines = [l.strip() for l in text.split("\n") if l.strip() and not l.strip().startswith("```")]
    if not lines:
        return None, "The Entries field is empty."
    if len(lines) > MAX_CHALLENGE_ENTRIES:
        return None, "At most %d entries per request." % MAX_CHALLENGE_ENTRIES
    out, seen = [], set()
    for k, l in enumerate(lines):
        parts = l.replace(",", " ").split()
        if len(parts) != 2:
            return None, "Line %d should be a target and a pattern." % (k + 1)
        tid, p = parts[0].upper(), parts[1]
        if len(p) == N_CELLS and not set(p) - set("01"):
            code = p
        elif len(p) == 27 and p[0] in "01" and not set(p.lower()) - set("0123456789abcdef"):
            code = format(int(p, 16), "0%db" % N_CELLS)
        else:
            return None, "Line %d: the pattern is not valid." % (k + 1)
        if tid in seen:
            return None, "Target %s appears more than once." % tid
        seen.add(tid)
        out.append((tid, code))
    return out, None


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
    return {"status": status, "offset_N": F0, "max_displacement_mm": stroke, "max_force_N": max(Fk) if Fk else 0.0,
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
    for attempt in range(40):                 # Windows: "Access is denied" while the rig program reads the file
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05)
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
        """Add, replace or delete several files in one commit. files: {path: bytes, or None to delete}."""
        for attempt in range(4):
            ref = self.req("GET", "/git/ref/heads/%s" % self.branch)
            head = ref["object"]["sha"]
            base_tree = self.req("GET", "/git/commits/%s" % head)["tree"]["sha"]
            tree = []
            for path, data in files.items():
                if data is None:
                    tree.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                    continue
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


# ------------------------------------------------------------------ live status (Firebase Realtime Database)
class LiveStatus:
    """Optional fast status channel for the website (free Firebase Realtime Database).

    Every `live_seconds` the agent writes a heartbeat to /rig/beat (server time), and the full public
    status to /rig/state whenever it changes (and at least every minute). The website listens to /rig
    and shows Offline when the heartbeat stops. The database rules allow anyone to read /rig and nobody
    to write; the agent writes with a service-account key (kept only on the rig computer), which the
    rules do not apply to. GitHub's "Machine status" request is still updated as the fallback.
    """
    SCOPES = ["https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/userinfo.email"]

    def __init__(self, url, key_file, session=None, token_provider=None):
        self.url = url.rstrip("/")
        self.key_file = key_file
        self.s = session or requests.Session()
        self._creds = None
        self._token_provider = token_provider          # tests pass a function returning a token

    def token(self):
        if self._token_provider:
            return self._token_provider()
        if self._creds is None:
            try:
                from google.oauth2 import service_account
            except ImportError:
                raise RuntimeError("google-auth is not installed on this computer. In Command Prompt run: "
                                   "python -m pip install google-auth   then restart Start rig.bat")
            self._creds = service_account.Credentials.from_service_account_file(self.key_file, scopes=self.SCOPES)
        if not self._creds.valid:
            from google.auth.transport.requests import Request
            self._creds.refresh(Request())
        return self._creds.token

    def _send(self, method, path, value):
        r = self.s.request(method, "%s/%s.json" % (self.url, path.strip("/")), data=json.dumps(value),
                           headers={"Authorization": "Bearer " + self.token()}, timeout=10)
        if r.status_code >= 300:
            raise RuntimeError("live status %s %s: %s %s" % (method, path, r.status_code, r.text[:200]))

    def beat(self):
        self._send("PUT", "rig/beat", {".sv": "timestamp"})

    def state(self, s):
        self._send("PUT", "rig/state", dict(s, updated={".sv": "timestamp"}))


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
        self.live = None
        if cfg.get("firebase_url") and (cfg.get("firebase_key_file") or cfg.get("_firebase_token")):
            self.live = LiveStatus(cfg["firebase_url"], cfg.get("firebase_key_file", ""),
                                   token_provider=cfg.get("_firebase_token"))

    def start_live(self):
        """Background thread: heartbeat + status to the live channel, independent of the GitHub loop
        (which can be busy uploading results for a while)."""
        if not self.live:
            return None
        t = threading.Thread(target=self.live_loop, name="live-status", daemon=True)
        t.start()
        return t

    def live_loop(self, rounds=None):
        period = float(self.cfg.get("live_seconds", 5))
        last_key, last_sent, last_err, k = None, 0.0, 0.0, 0
        while rounds is None or k < rounds:
            k += 1
            try:
                s = self.public_state(self.rig_status())
                key = json.dumps(s, sort_keys=True)
                if key != last_key or time.time() - last_sent > 60:
                    self.live.state(s)
                    last_key, last_sent = key, time.time()
                self.live.beat()
                if not getattr(self, "_live_ok", False):
                    self._live_ok = True
                    log.info("live status: connected, the website now gets the status every %ss", period)
            except Exception as e:                   # never stop; report at most once a minute
                if time.time() - last_err > 60:
                    log.warning("live status: %s", e)
                    last_err = time.time()
            if rounds is None or k < rounds:
                time.sleep(period)

    def save_state(self):
        write_json_atomic(self.state_file, self.state)

    # ---- what the rig program reports
    def rig_status(self):
        f = self.q / "rig_status.json"
        s = None
        for attempt in range(5):                  # the rig program may be replacing the file right now
            try:
                s = json.loads(f.read_text())
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        if s is None:
            return None
        if time.time() - float(s.get("time", 0)) > self.cfg.get("rig_stale_seconds", 60):
            return None
        return s

    def public_state(self, rig):
        s = self._public_state(rig)
        s["last"] = self.state.get("last_result")       # the page shows its pattern and curve
        if rig and rig.get("pos") and s.get("state") != "busy":
            s["pos"] = rig["pos"]                        # Ender positions (X, Y, Z) for the Admin page
        return s

    def _public_state(self, rig):
        queue = len(self._queued_cache) if hasattr(self, "_queued_cache") else None
        per = self.minutes_per_test()
        f = self.q / "rig_status.json"
        silent = time.time() - (f.stat().st_mtime if f.exists() else 0)
        if self.program_closed():
            return {"state": "offline", "message": "The rig program is closed.", "job": None, "queue": queue, "minutes_per_test": per}
        if rig is None and (not self.state["current"] or silent > 900):   # nothing for 15 min: the program is gone
            return {"state": "offline", "message": "The rig program is not running.", "job": None, "queue": queue, "minutes_per_test": per}
        if rig is None:                         # a job was handed over but the rig's status file is late: still testing
            rig = {"state": "busy", "job": self.state["current"]}
        if rig.get("state") == "busy" or self.state["current"]:
            job = rig.get("job") or self.state["current"]
            s = {"state": "busy", "message": "", "job": job, "queue": queue, "minutes_per_test": per}
            s["pattern"] = self.state.get("current_pattern")
            s["name"] = self.state.get("current_name")
            ak = self.state.get("auto_jobs", {}).get(str(job))
            if ak:
                s["job"], s["auto"] = "auto-%d" % ak, ak
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
            setup = rig.get("setup_note") or "The machine is switched on but not set up for testing yet."
            return {"state": "paused", "message": note or ("Being set up. " + setup if rig.get("setup_note") else setup), "job": None, "queue": queue, "minutes_per_test": per}
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
        found = sorted([i for i in self.gh.issues(state="open") if "machine-status" in self.gh.labels_of(i)],
                       key=lambda i: i["number"])
        if not found and self.state.get("status_issue"):          # the list can briefly come back empty
            self.status_issue = self.state["status_issue"]
            return self.status_issue
        if found:
            self.status_issue = found[0]["number"]
            for extra in found[1:]:                              # only one status request should be open
                self.gh.edit_issue(extra["number"], state="closed", state_reason="not_planned")
            self.state["status_issue"] = self.status_issue
            self.save_state()
        else:
            self.gh.ensure_label("machine-status", "8A96A0", "Live status of the rig (updated by the lab computer)")
            body = self.status_body({"state": "offline", "message": "", "job": None, "updated": now_iso()})
            self.status_issue = self.gh.create_issue(STATUS_TITLE, body, ["machine-status"])["number"]
            self.state["status_issue"] = self.status_issue
            self.save_state()
            self.gh.lock(self.status_issue)
        return self.status_issue

    def status_body(self, s):
        return ("The lab computer updates this issue automatically so the rig page can show whether the machine is "
                "available. Please don't comment here.\n\n**%s**%s\n\n```json\n%s\n```\n"
                % (STATUS_TEXT.get(s["state"], s["state"]),
                   (": " + s["message"]) if s.get("message") else "", json.dumps(s, indent=1)))

    def publish(self, s):
        key = json.dumps({k: s.get(k) for k in ("state", "message", "job", "queue", "batch_index", "last", "pos")}, sort_keys=True)
        last_key, last_t = self.last_published
        if key == last_key and time.time() - last_t < self.cfg.get("heartbeat_seconds", 120):
            return
        s = dict(s, updated=now_iso())
        self.gh.edit_issue(self.find_status_issue(), body=self.status_body(s))
        self.last_published = (key, time.time())
        log.info("status: %s %s", s["state"], s.get("message") or "")

    # ---- queue
    def queued(self):
        """Waiting requests in the order they run: those the lab moved to the front ("priority" label,
        Admin page) first, then oldest first. Requests from blocked accounts are skipped."""
        # listed without GitHub's label filter, which sometimes returns nothing, and filtered here
        items = [i for i in self.gh.issues(state="open", sort="created", direction="asc") if "queued" in self.gh.labels_of(i)]
        blocked = self.blocked_users()
        items = [i for i in items if not ({"running", "done", "failed", "invalid", "cancelled"} & self.gh.labels_of(i))
                 and (i.get("user") or {}).get("login", "").lower() not in blocked]
        items.sort(key=lambda i: 0 if "priority" in self.gh.labels_of(i) else 1)   # stable: keeps oldest first
        self._queued_cache = items
        return items

    # ---- settings from the website's Admin page (files in control/ on GitHub)
    def blocked_users(self):
        now = time.time()
        if now - getattr(self, "_blocked_at", 0) > 60:          # read at most once a minute
            try:
                data = json.loads(self.gh.file_text("control/blocked.json") or "{}")
                self._blocked = {u.lower() for u in data.get("users", []) if isinstance(u, str)}
            except (ValueError, RuntimeError, AttributeError) as e:
                log.warning("could not read control/blocked.json: %s", e)
                self._blocked = getattr(self, "_blocked", set())
            self._blocked_at = now
        return self._blocked

    def apply_remote_control(self):
        """Pause / resume web jobs from the Admin page (control/rig.json). Applied when the file changes
        and once when the agent starts, so a pause set on the website survives a restart of the rig."""
        try:
            text = self.gh.file_text("control/rig.json")
        except RuntimeError as e:
            log.warning("could not read control/rig.json: %s", e)
            return
        if not text:
            return
        try:
            ctl = json.loads(text)
        except ValueError:
            log.warning("control/rig.json is not valid JSON; ignored")
            return
        self.auto_enabled = ctl.get("auto_fill", True) is not False
        self.maintenance = bool(ctl.get("maintenance"))
        mflag = self.q / "maintenance"                  # the rig program only moves single axes while this exists
        if self.maintenance and not mflag.exists():
            mflag.write_text("maintenance mode (Admin page)\n")
            log.info("Admin page: maintenance mode on")
        elif not self.maintenance and mflag.exists():
            mflag.unlink()
            log.info("Admin page: maintenance mode off")
        cmds = ctl.get("commands") if isinstance(ctl.get("commands"), list) else [ctl.get("command")]
        for c in sorted([c for c in cmds if isinstance(c, dict)], key=lambda c: str(c.get("at"))):
            self.run_command(c)
        key = "%s|%s|%s" % (ctl.get("updated"), ctl.get("accepting"), ctl.get("note"))
        if key == getattr(self, "_control_seen", None):
            return
        first = getattr(self, "_control_seen", None) is None
        self._control_seen = key
        flag, note = self.q / "accepting", self.q / "pause_message.txt"
        if ctl.get("accepting"):
            flag.write_text("web jobs allowed (Admin page)\n")
            if note.exists():
                note.unlink()
            log.info("Admin page: web jobs allowed")
        else:
            if flag.exists():
                flag.unlink()
            note.write_text(ctl.get("note") or "")
            log.info("Admin page: web jobs paused %s", ctl.get("note") or "")
            if ctl.get("home") and not first:          # "Stop after this test": home once the test has finished
                (self.q / "home_request").write_text(ctl.get("updated") or "")
                log.info("Admin page: the rig homes after the current test")

    # ---- one-off commands from the Admin page: {"id": ..., "action": ..., "at": ISO time}
    PROGRAM_ACTIONS = ("start_program", "stop_program", "restart_program")      # done by start_rig.py
    RIG_ACTIONS = {"setup": "setup_request", "home": "home_request", "halt": "halt_request",
                   "estop": "estop_request"}                                           # done by the rig program

    def run_command(self, cmd):
        """Run each command once, and only if it was given in the last 3 minutes (an old command is never
        repeated after a restart)."""
        if not isinstance(cmd, dict) or not cmd.get("id"):
            return
        done = self.state.setdefault("commands_done", [])
        if cmd["id"] in done:
            return
        done.append(cmd["id"])
        del done[:-50]
        self.save_state()
        try:
            age = time.time() - datetime.fromisoformat(str(cmd.get("at")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            age = 1e9
        if age > 180:
            log.info("Admin page command %s is %d s old; not run", cmd.get("action"), age)
            return
        action = cmd.get("action")
        if action == "move" and not getattr(self, "maintenance", False):
            log.warning("Admin page: move ignored (maintenance mode is off)")
            return
        if action == "move":
            write_json_atomic(self.q / ("move_request_%s.json" % cmd["id"]), {"id": cmd["id"], "ender": cmd.get("ender"),
                                                             "axis": cmd.get("axis"), "mm": cmd.get("mm")})
        elif action in self.PROGRAM_ACTIONS:
            write_json_atomic(self.q / "supervisor_command.json", {"id": cmd["id"], "action": action})
        elif action in self.RIG_ACTIONS:
            (self.q / self.RIG_ACTIONS[action]).write_text(cmd["id"])
        else:
            log.warning("unknown Admin page command %s", action)
            return
        log.info("Admin page command: %s", action)

    def program_closed(self):
        """True when start_rig.py reports (within the last 30 s) that the rig program is not running."""
        f = self.q / "supervisor_status.json"
        try:
            st = json.loads(f.read_text())
        except (OSError, ValueError):
            return False
        return time.time() - float(st.get("time", 0)) < 30 and not st.get("program_running")

    def dispatch(self, rig):
        busy = self.state["current"] or any((self.q / "inbox").glob("*.json")) or any((self.q / "running").glob("*.json"))
        ready = rig and rig.get("state") == "idle" and rig.get("accepting") and rig.get("hardware_ready", True)
        # automatic testing starts after 2 quiet minutes: no request waiting or running, the rig allowed to take
        # jobs. Automatic patterns themselves don't count as activity, so they follow each other directly.
        b = self.state.get("batch")
        auto_now = str(self.state["current"]) in self.state.get("auto_jobs", {})
        allowed = rig and rig.get("accepting") and rig.get("hardware_ready", True)
        manual = rig and rig.get("state") != "idle" and not self.state["current"]     # someone using the rig program
        if (busy and not auto_now) or manual or not allowed or getattr(self, "_queued_cache", None) or (b and b["next"] < len(b["codes"])):
            self._idle_since = None
        if busy or not ready:
            return
        b = self.state.get("batch")
        if b and b["next"] < len(b["codes"]):          # a batch in progress runs to the end first
            self.dispatch_batch_pattern()
            return
        for issue in self.queued():
            n = issue["number"]
            if "batch-request" in self.gh.labels_of(issue):
                targets_of = None
                if "challenge" in self.gh.labels_of(issue):
                    entries, why = parse_challenge_entries(issue.get("body"))
                    codes = [c for _, c in entries] if entries else None
                    targets_of = [t for t, _ in entries] if entries else None
                else:
                    codes, why = parse_batch(issue.get("body"))
                if not codes:
                    self.gh.remove_label(n, "queued")
                    self.gh.add_labels(n, ["invalid"])
                    self.gh.comment(n, "**The rig could not read this batch.** %s Upload the zip on the rig page again." % why)
                    continue
                self.state["batch"] = {"issue": n, "codes": codes, "next": 0, "results": {},
                                       "submitted_by": issue["user"]["login"], "name": submitter_name(issue)}
                if targets_of:                       # challenge entries: each pattern is scored against its target
                    self.state["batch"].update(targets=targets_of, method=section(issue.get("body"), "method")[:1500])
                self.save_state()
                self.gh.remove_label(n, "queued")
                self.gh.add_labels(n, ["running"])
                self.gh.comment(n, "**Started on the rig.** The %d patterns are tested one after another in the order they were listed. "
                                   "You can watch on the live view; the results are posted here when the batch is finished." % len(codes))
                self.dispatch_batch_pattern()
                return
            code, why = parse_pattern(issue.get("body"))
            if not code:
                self.gh.remove_label(n, "queued")
                self.gh.add_labels(n, ["invalid"])
                self.gh.comment(n, "**The rig could not read this pattern.** %s Edit the request to fix it." % why)
                continue
            job = {"issue": n, "pattern": code, "submitted_by": issue["user"]["login"], "name": submitter_name(issue),
                   "dispatched": now_iso()}
            write_json_atomic(self.q / "inbox" / ("%d.json" % n), job)
            self.state["current"] = n
            self.state["current_pattern"] = code
            self.state["current_name"] = job["name"]
            self.state["started_" + str(n)] = time.time()
            self.save_state()
            self.gh.remove_label(n, "queued")
            self.gh.add_labels(n, ["running"])
            self.gh.comment(n, "**Started on the rig.** The robot is placing the inserts now. You can watch on the live view; results will be posted here.")
            log.info("dispatched #%d", n)
            self.state["auto_run"] = False
            return
        self.dispatch_auto()

    # ---- automatic data-set patterns while the queue is empty
    def known_keys(self):
        """Patterns already measured: the published data set plus everything tested from the queue (and the
        automatic patterns). Read from GitHub once an hour."""
        if time.time() - getattr(self, "_known_at", 0) > 3600:
            keys = set((self.gh.file_text("docs/data/keys.txt") or "").split())
            add = self.gh.file_text("results/dataset_additions.csv") or ""
            for line in add.splitlines()[1:]:
                parts = line.split(",")
                if len(parts) > 3 and len(parts[3]) == 105:
                    keys.add(key_of(parts[3]))
            self._known, self._known_at = keys, time.time()
        return self._known

    def dispatch_auto(self):
        minutes = self.cfg.get("auto_fill_minutes", 2)
        if not minutes or not getattr(self, "auto_enabled", True):
            return
        if not getattr(self, "_idle_since", None):
            self._idle_since = time.time()
            return
        if time.time() - self._idle_since < minutes * 60:
            return
        try:
            known = self.known_keys()
        except RuntimeError as e:
            log.warning("automatic testing: could not read the data set list (%s)", e)
            return
        if not known:
            return
        code = new_island_pattern(known)
        if not code:
            log.warning("automatic testing: no new island pattern found this time")
            return
        known.add(key_of(code))
        k = self.state.get("auto_count", 0) + 1
        self.state["auto_count"] = k
        jid = AUTO_BASE + k
        # a run of automatic patterns is treated like a batch: the rig homes before the first one only
        job = {"issue": jid, "pattern": code, "submitted_by": "", "name": "Automatic (island algorithm)",
               "dispatched": now_iso(), "auto": k, "batch_index": 1 if self.state.get("auto_run") else 0}
        write_json_atomic(self.q / "inbox" / ("%d.json" % jid), job)
        self.state.setdefault("auto_jobs", {})[str(jid)] = k
        self.state["auto_run"] = True
        self.state["current"] = jid
        self.state["current_pattern"] = code
        self.state["current_name"] = "Automatic (island algorithm)"
        self.state["started_" + str(jid)] = time.time()
        self.save_state()
        log.info("automatic pattern %d dispatched (%d inserts)", k, code.count("1"))

    def auto_result(self, jid, k, folder, info):
        """Publish one automatic pattern: results/auto/<k>/ and its rows in index.csv / dataset_additions.csv."""
        if not info.get("ok"):
            log.warning("automatic pattern %d did not finish: %s", k, info.get("message"))
            return
        self._frames_limit = self.cfg.get("auto_frames", 1)      # keep the repository small: one photo by default
        try:
            files, curve, _, _ = self.result_files("auto-%d" % k, folder, info, "", "results/auto/%d/" % k,
                                                   name="Automatic (island algorithm)")
        finally:
            self._frames_limit = None
        self.gh.commit_files(files, "Results for automatic pattern %d" % k)
        log.info("published automatic pattern %d (%s, %.1f mm)", k, curve["status"], curve["max_displacement_mm"])

    def dispatch_batch_pattern(self):
        self.state["auto_run"] = False
        b = self.state["batch"]
        n, k = b["issue"], b["next"]
        jid = BATCH_BASE + n * 1000 + k
        job = {"issue": jid, "pattern": b["codes"][k], "submitted_by": b["submitted_by"], "name": b.get("name", ""), "dispatched": now_iso(),
               "batch_request": n, "batch_index": k}
        write_json_atomic(self.q / "inbox" / ("%d.json" % jid), job)
        self.state.setdefault("jobs", {})[str(jid)] = [n, k]
        b["next"] = k + 1
        self.state["current"] = jid
        self.state["current_pattern"] = b["codes"][k]
        self.state["current_name"] = b.get("name", "")
        self.state["started_" + str(jid)] = time.time()
        self.save_state()
        log.info("dispatched #%d pattern %d of %d", n, k + 1, len(b["codes"]))

    # ---- results
    def collect(self):
        """Publish each finished job once, then move its folder to archive/. If the move fails (a file still
        open on Windows), the job is NOT published again; only the move is retried next cycle."""
        published = self.state.setdefault("published", [])
        for done in sorted((self.q / "outbox").glob("*/done.json")):
            folder = done.parent
            n = int(folder.name)
            key = "%s@%d" % (folder.name, int(done.stat().st_mtime))
            if key not in published:
                nk = self.state.get("jobs", {}).get(str(n))
                ak = self.state.get("auto_jobs", {}).get(str(n))
                try:
                    info = json.loads(done.read_text())
                    if ak:
                        self.auto_result(n, ak, folder, info)
                    elif nk:
                        self.batch_result(nk[0], nk[1], folder, info)
                    elif info.get("ok"):
                        self.publish_result(n, folder, info)
                    else:
                        self.report_failure(n, info.get("message", "unknown reason"))
                except Exception as e:                  # keep the folder; try again next cycle
                    log.exception("could not publish #%d: %s", n, e)
                    continue
                published.append(key)
                del published[:-300]
                t0 = self.state.pop("started_" + str(n), None)
                if t0 and info.get("ok"):
                    self.state["durations_min"].append((time.time() - t0) / 60)
                if self.state["current"] == n:
                    self.state["current"] = None
                    self.state["current_pattern"] = None
                    self.state["current_name"] = None
                if nk:
                    self.state["jobs"].pop(str(n), None)
                if ak:
                    self.state["auto_jobs"].pop(str(n), None)
                self.save_state()
                if nk:
                    self.finish_batch_if_done()
            target = self.q / "archive" / folder.name
            try:
                if target.exists():
                    shutil.rmtree(target)
                shutil.move(str(folder), str(target))
            except OSError as e:
                log.warning("published #%d but could not move its folder to archive yet (%s); retrying later", n, e)

    def report_failure(self, n, message):
        self.gh.remove_label(n, "running")
        self.gh.add_labels(n, ["failed"])
        self.gh.comment(n, "**The test did not finish.** %s\n\nA lab member will look at it and can put the pattern back in the queue." % message)
        log.warning("#%d failed: %s", n, message)

    def result_files(self, n, folder, info, submitted_by, base, batch_index=None, name=""):
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
                "submitted_by": submitted_by, "submitted_name": name or submitted_by, "tested_at": info.get("finished") or now_iso(),
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
        png = self.plot(curve, n if batch_index is None else "%s, pattern %d" % (n, batch_index))
        if png:
            files[base + "curve.png"] = png
        idx = self.gh.file_text("results/index.csv") or INDEX_HEADER
        idx += "%s,%s,%s,%.3f,%s,%s\n" % (n, "" if batch_index is None else batch_index, meta["tested_at"],
                                          curve["max_displacement_mm"], curve["status"], code)
        files["results/index.csv"] = idx.encode()
        if curve["status"] == "ok":
            # one line per run in data-set form; the web page merges these into the download
            add = self.gh.file_text("results/dataset_additions.csv") or ADDITIONS_HEADER
            add += "%s,%s,%.4f,%s,%s\n" % (n, meta["tested_at"], curve["max_displacement_mm"], code,
                                           " ".join("%.5f" % v for v in curve["dataData"]))
            files["results/dataset_additions.csv"] = add.encode()
        self.state["last_result"] = {"issue": n, "batch_index": batch_index, "name": name or submitted_by, "curve": base + "curve.json",
                                     "frames": (base + "frames.json") if frames else None, "pattern": code}
        return files, curve, photos, png

    def publish_result(self, n, folder, info):
        issue = self.gh.req("GET", "/issues/%d" % n)
        base = "results/%d/" % n
        files, curve, photos, png = self.result_files(n, folder, info, issue["user"]["login"], base, name=submitter_name(issue))
        score_line = ""
        if "challenge" in self.gh.labels_of(issue):
            score_line = self.score_challenge(n, issue, curve, files)
        self.gh.commit_files(files, "Results for pattern request #%d" % n)

        lines = ["**Tested.** " + ("The force reached 20 N at **%.1f mm**." % curve["max_displacement_mm"]
                                   if curve["status"] == "ok" else
                                   "The compression stopped at the travel limit (**%.1f mm**) before the force reached 20 N; "
                                   "the force there was **%.1f N**. This run is published with its curve but is not added to the "
                                   "data set, which holds curves up to 20 N." % (curve["max_displacement_mm"], curve.get("max_force_N", 0)))]
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
            files, curve, _, _ = self.result_files(n, folder, info, b["submitted_by"], base + "%d/" % k, batch_index=k, name=b.get("name", ""))
            entry.update(status=curve["status"], max_displacement_mm=round(curve["max_displacement_mm"], 3),
                         max_force_N=round(curve.get("max_force_N", 0), 2),
                         force_N=[round(v, 3) for v in curve["force_N"]], tested_at=info.get("finished") or now_iso())
            if b.get("targets"):
                tid = b["targets"][k]
                entry["target"] = tid
                res = self.add_to_leaderboard(n, b["submitted_by"], tid, b.get("method", ""), curve, files,
                                              b["codes"][k], base + "%d/curve.json" % k, batch_index=k,
                                              name=b.get("name", ""))
                entry.update(res)
        else:
            entry.update(status="failed", message=info.get("message", "unknown reason"))
            self.gh.comment(n, "**Pattern %d of this batch did not finish.** %s\n\nThe rest of the batch continues once a lab "
                               "member has checked the machine." % (k, entry["message"]))
        b["results"][str(k)] = entry
        summary = {"issue": n, "total": len(b["codes"]), "submitted_by": b["submitted_by"], "submitted_name": b.get("name", ""),
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
        if b.get("targets"):
            lines = ["**Challenge entries finished: %d of %d patterns tested and scored.**" % (len(ok), len(rows)), "",
                     "| Target | Inserts | 20 N reached at | Score (N) | Rank | Result |", "|---|---:|---:|---:|---:|---|"]
            for r in rows:
                lines.append("| %s | %d | %s | %s | %s | %s |" % (
                    r.get("target", b["targets"][r["index"]]), r["pattern"].count("1"),
                    "%.1f mm" % r["max_displacement_mm"] if r.get("max_displacement_mm") is not None else "–",
                    "**%.3f**" % r["score_N"] if r.get("score_N") is not None else "–",
                    "%d of %d" % (r["rank"], r["of"]) if r.get("rank") else "–",
                    "ok" if r["status"] == "ok" and r.get("score_N") is not None else r.get("score_note") or r.get("message") or r["status"]))
            lines.append("\nRanks are as of the moment each pattern was scored; the live leaderboard is on the "
                         "[Challenge page](https://%s.github.io/%s/challenge.html)." % (self.cfg.get("owner", ""), self.cfg.get("repo", "")))
            rows_done = True
        else:
            rows_done = False
            lines = ["**Batch finished: %d of %d patterns reached 20 N.**" % (len(ok), len(rows)), "",
                     "| Index | Inserts | 20 N reached at | Result |", "|---:|---:|---:|---|"]
        for r in ([] if rows_done else rows):
            lines.append("| %d | %d | %s | %s |" % (r["index"], r["pattern"].count("1"),
                         "%.1f mm" % r["max_displacement_mm"] if r.get("max_displacement_mm") is not None else "–",
                         "ok" if r["status"] == "ok" else
                         "stopped at the travel limit, %.1f N" % r["max_force_N"] if r["status"] == "below 20 N" and r.get("max_force_N") is not None
                         else r.get("message") or r["status"]))
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
        k = self._frames_limit if getattr(self, "_frames_limit", None) is not None else self.cfg.get("max_frames", 40)
        if k <= 0:
            return []
        if len(pairs) > k and k == 1:
            pairs = pairs[-1:]
        elif len(pairs) > k:
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

    def challenge_targets(self):
        try:
            return {t["id"]: t for t in json.loads(self.gh.file_text("docs/data/challenge.json"))["targets"]}
        except (TypeError, ValueError, KeyError):
            return None

    def add_to_leaderboard(self, n, user, tid, method, curve, files, pattern, curve_path, batch_index=None, name=""):
        """Score one tested pattern against target tid and add it to results/leaderboard.json (in `files`).
        Returns {"score_N", "stroke_error_mm", "rank", "of"} or {"score_note": reason}."""
        targets = self.challenge_targets()
        if targets is None:
            return {"score_note": "targets could not be read; a lab member will score it"}
        if tid not in targets:
            return {"score_note": "target %s does not exist" % (tid or "(none)")}
        if curve["status"] != "ok":
            return {"score_note": "the force did not reach 20 N"}
        score, dstroke = challenge_score(curve["dataData"], curve["max_displacement_mm"], targets[tid])
        key = (n, batch_index)
        if "results/leaderboard.json" in files:
            board = json.loads(files["results/leaderboard.json"])
        else:
            board = json.loads(self.gh.file_text("results/leaderboard.json") or "[]")
        board = [e for e in board if (e.get("issue"), e.get("batch_index")) != key]
        board.append({"issue": n, "batch_index": batch_index, "user": user, "name": name or user, "target": tid, "score_N": score,
                      "stroke_error_mm": dstroke, "max_displacement_mm": round(curve["max_displacement_mm"], 3),
                      "tested_at": now_iso(), "method": method, "pattern": pattern, "curve": curve_path})
        files["results/leaderboard.json"] = json.dumps(board, indent=1).encode()
        same = [e for e in board if e["target"] == tid]
        return {"score_N": score, "stroke_error_mm": dstroke,
                "rank": 1 + len([e for e in same if e["score_N"] < score]), "of": len(same)}

    def score_challenge(self, n, issue, curve, files):
        """Score a single challenge entry (challenge.yml) and return the comment line."""
        body = issue.get("body") or ""
        tid = section(body, "target").split()[0].strip(".:,").upper() if section(body, "target") else ""
        r = self.add_to_leaderboard(n, issue["user"]["login"], tid, section(body, "method")[:1500], curve, files,
                                    (self.state.get("last_result") or {}).get("pattern"), "results/%d/curve.json" % n,
                                    name=submitter_name(issue))
        if "score_note" in r:
            return "This entry was not scored: %s." % r["score_note"]
        return ("**Challenge %s: score %.3f N** (RMS force difference of the 200-point curves; lower is better). "
                "The displacement at 20 N differs by %+.1f mm from the target. Current rank on %s: %d of %d."
                % (tid, r["score_N"], r["stroke_error_mm"], tid, r["rank"], r["of"]))

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
        ax.set_title(("Automatic pattern %s" % str(n)[5:]) if str(n).startswith("auto-") else "Pattern request #%s" % n,
                     loc="left", fontsize=10)
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png")
        plt.close(fig)
        return buf.getvalue()

    # ---- one cycle
    def forget_lost_job(self, rig):
        """The agent remembers the job it handed to the rig ("current"). If the rig is idle and that job is nowhere
        in the queue folder (no inbox/running/outbox file), the job was lost, e.g. the program was closed or an
        older agent left a stale state. Forget it after 2 minutes, so the status and the queue don't stay stuck."""
        cur = self.state.get("current")
        if not cur:
            self._lost_since = None
            return
        n = str(cur)
        present = (self.q / "inbox" / (n + ".json")).exists() or (self.q / "running" / (n + ".json")).exists() \
            or (self.q / "outbox" / n).exists()
        if present or not rig or rig.get("state") != "idle" or rig.get("job") is not None:
            self._lost_since = None
            return
        if not getattr(self, "_lost_since", None):
            self._lost_since = time.time()
            return
        if time.time() - self._lost_since < 120:
            return
        log.warning("job #%s is not in the queue folder and the rig is idle; forgetting it", cur)
        nk = self.state.get("jobs", {}).pop(n, None)
        if nk and self.state.get("batch") and self.state["batch"]["issue"] == nk[0]:
            self.state["batch"]["results"][str(nk[1])] = {"index": nk[1], "pattern": self.state["batch"]["codes"][nk[1]],
                                                          "status": "failed", "message": "lost (the rig program was restarted)"}
        self.state["current"] = None
        self.state["current_pattern"] = None
        self.state["current_name"] = None
        self.save_state()
        self._lost_since = None
        if nk:
            self.finish_batch_if_done()

    # ---- photos are kept for photo_days (default 42) days, then deleted (curves and data stay)
    def cleanup_photos(self):
        """Once a day: delete photos older than photo_days on this computer (web_queue/archive/*/images)
        and on GitHub (results/**/frames/ and frames.json; curve.json then says frames = 0)."""
        days = self.cfg.get("photo_days", 42)
        if not days or time.time() - self.state.get("photos_cleaned", 0) < 86400:
            return
        cutoff = time.time() - days * 86400
        freed = 0
        for img in (self.q / "archive").glob("*/images"):
            try:
                if img.is_dir() and img.parent.stat().st_mtime < cutoff:
                    freed += sum(f.stat().st_size for f in img.rglob("*") if f.is_file())
                    shutil.rmtree(img)
            except OSError as e:
                log.warning("could not delete %s: %s", img, e)
        if freed:
            log.info("deleted %.0f MB of photos older than %d days on this computer", freed / 1e6, days)
        try:
            self.cleanup_published_photos(cutoff, days)
            self.cleanup_challenge_curves(cutoff, days)
        except RuntimeError as e:
            log.warning("could not clean old photos on GitHub: %s", e)
            return
        self.state["photos_cleaned"] = time.time()
        self.save_state()

    def cleanup_challenge_curves(self, cutoff, days):
        """Challenge entries keep their stored curve (curve.json, curve.png, raw.csv) only while they are in the
        top 3 for their target. Older entries outside the top 3 lose the curve files after `days` days; their
        score, name and method stay on the leaderboard (the entry then has "curve": null)."""
        text = self.gh.file_text("results/leaderboard.json")
        if not text:
            return
        board = json.loads(text)
        top = set()
        for tid in {e.get("target") for e in board}:
            same = sorted((e for e in board if e.get("target") == tid), key=lambda e: e.get("score_N", 1e9))
            top.update(id(e) for e in same[:3])
        files, changed = {}, 0
        for e in board:
            if id(e) in top or not e.get("curve"):
                continue
            try:
                t = datetime.fromisoformat(e.get("tested_at", "").replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
            if t >= cutoff:
                continue
            base = e["curve"].rsplit("/", 1)[0] + "/"
            for name in ("curve.json", "curve.png", "raw.csv"):
                files[base + name] = None
            e["curve"] = None
            e["curve_removed"] = now_iso()[:10]
            changed += 1
        if not changed:
            return
        files["results/leaderboard.json"] = json.dumps(board, indent=1).encode()
        self.gh.commit_files(files, "Remove stored curves of %d challenge entries outside the top 3 after %d days" % (changed, days))
        log.info("removed the stored curves of %d challenge entries outside the top 3", changed)

    def cleanup_published_photos(self, cutoff, days):
        idx = self.gh.file_text("results/index.csv") or ""
        old = set()
        for line in idx.splitlines()[1:]:
            c = line.split(",")
            if len(c) < 3:
                continue
            try:
                t = datetime.fromisoformat(c[2].replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
            if t >= cutoff:
                continue
            n, k = c[0], c[1]
            base = ("results/auto/%s/" % n[5:]) if n.startswith("auto-") else ("results/%s/%s/" % (n, k) if k else "results/%s/" % n)
            old.add(base)
        if not old:
            return
        tree = self.gh.req("GET", "/git/trees/%s" % self.gh.branch, params={"recursive": "1"})
        paths = [e["path"] for e in tree.get("tree", []) if e.get("type") == "blob"]
        files = {}
        for base in old:
            pics = [p for p in paths if p.startswith(base + "frames/") or p == base + "frames.json"]
            if not pics:
                continue
            for p in pics:
                files[p] = None
            curve = self.gh.file_text(base + "curve.json")
            if curve:
                try:
                    meta = json.loads(curve)
                    meta["frames"] = 0
                    meta["photos_removed"] = now_iso()[:10]
                    files[base + "curve.json"] = json.dumps(meta).encode()
                except ValueError:
                    pass
            if len(files) > 2000:
                break
        if files:
            self.gh.commit_files(files, "Remove photos older than %d days" % days)
            log.info("removed %d old photo files on GitHub", sum(1 for v in files.values() if v is None))

    def squash_history(self, rig):
        """Every history_days (default 42) days, while the rig is idle and the queue empty: replace the repository's
        history by one commit holding all current files, so deleted photos really leave the repository.
        GitHub frees the space some time after (its own clean-up runs on its schedule)."""
        days = self.cfg.get("history_days", 42)
        last = self.state.get("history_squashed")
        if not days:
            return
        if last is None:                                # first run: start counting from now
            self.state["history_squashed"] = time.time()
            self.save_state()
            return
        if time.time() - last < days * 86400:
            return
        if self.state["current"] or getattr(self, "_queued_cache", None) or not rig or rig.get("state") != "idle":
            return
        gh = self.gh
        head = gh.req("GET", "/git/ref/heads/%s" % gh.branch)["object"]["sha"]
        tree = gh.req("GET", "/git/commits/%s" % head)["tree"]["sha"]
        commit = gh.req("POST", "/git/commits", json={
            "message": "Repository history cleaned: all files as of %s (old photos removed for good)" % now_iso()[:10],
            "tree": tree, "parents": []})
        if gh.req("GET", "/git/ref/heads/%s" % gh.branch)["object"]["sha"] != head:
            log.info("history clean-up postponed: the branch just changed")
            return
        gh.req("PATCH", "/git/refs/heads/%s" % gh.branch, json={"sha": commit["sha"], "force": True})
        self.state["history_squashed"] = time.time()
        self.save_state()
        log.info("repository history replaced by one commit (%s)", commit["sha"][:7])

    def tick(self, publish_status=True):
        self.apply_remote_control()
        self.cleanup_photos()
        try:
            self.squash_history(self.rig_status())
        except RuntimeError as e:
            log.warning("could not clean the repository history: %s", e)
        rig = self.rig_status()
        self.collect()
        self.forget_lost_job(rig)
        try:
            self.queued()
        except RuntimeError as e:
            log.warning("could not read the queue: %s", e)
        self.dispatch(rig)
        if publish_status:
            self.publish(self.public_state(self.rig_status()))


# ------------------------------------------------------------------ command line
DEFAULT_CONFIG = {
    "owner": "adamslab-gibert", "repo": "metamaterial-rig", "branch": "main",
    "token_env": "RIG_GITHUB_TOKEN",
    "queue_dir": "web_queue",            # relative paths are taken from this file's folder
    "poll_seconds": 20, "heartbeat_seconds": 120, "rig_stale_seconds": 10,
    "max_frames": 40, "frame_width": 720,
    "firebase_url": "", "firebase_key_file": "", "live_seconds": 5,
    "auto_fill_minutes": 2,              # test new island patterns after this many quiet minutes (0 = never)
    "auto_frames": 1,                    # photos kept per automatic pattern (requests keep up to max_frames)
    "photo_days": 42,                    # delete photos (here and on GitHub) after this many days (0 = keep)
    "history_days": 42,                  # replace the GitHub history by one commit this often (0 = never)
}


_instance_socket = None


def single_instance():
    """Only one agent may run on this computer (two would publish every result twice)."""
    global _instance_socket
    import socket
    _instance_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        _instance_socket.bind(("127.0.0.1", 47862))
        _instance_socket.listen(1)
    except OSError:
        sys.exit("Another lab agent is already running on this computer. Close it first "
                 "(Task Manager -> Details -> end the extra python.exe), or just keep using it.")


def watch_launcher():
    """When started by start_rig.py, stop as soon as the launcher window is closed."""
    pid = int(os.environ.get("RIG_LAUNCHER_PID", "0") or 0)
    if not pid:
        return

    def alive():
        if os.name == "nt":
            import ctypes
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x00100000, False, pid)          # SYNCHRONIZE
            if not h:
                return False
            try:
                return k.WaitForSingleObject(h, 0) == 0x102      # WAIT_TIMEOUT = still running
            finally:
                k.CloseHandle(h)
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def loop():
        while alive():
            time.sleep(5)
        log.info("launcher closed; agent stops")
        os._exit(0)
    threading.Thread(target=loop, daemon=True).start()


def load_config():
    """Defaults, overridden by agent_config.json next to this file if it exists.
    With agent.py in the rig program's folder no settings file is needed."""
    cfg = dict(DEFAULT_CONFIG)
    path = HERE / "agent_config.json"
    if path.exists():
        cfg.update(json.loads(path.read_text()))
    for k in ("queue_dir", "firebase_key_file"):
        if cfg.get(k) and not Path(cfg[k]).is_absolute():
            cfg[k] = str(HERE / cfg[k])
    # live status without a settings file: a Firebase key saved as firebase_key.json in the rig_keys folder
    # of the user's home folder (or next to this file) switches it on; the database address comes from the
    # key's project ("<project>-default-rtdb.firebaseio.com", a database created in the United States)
    if not cfg.get("firebase_key_file"):
        for f in (Path.home() / "rig_keys" / "firebase_key.json", HERE / "firebase_key.json"):
            if f.exists():
                cfg["firebase_key_file"] = str(f)
                break
    if cfg.get("firebase_key_file") and not cfg.get("firebase_url"):
        try:
            project = json.loads(Path(cfg["firebase_key_file"]).read_text()).get("project_id")
            if project:
                cfg["firebase_url"] = "https://%s-default-rtdb.firebaseio.com" % project
        except (OSError, ValueError):
            pass
    return cfg


def main(argv):
    import logging.handlers   # agent.log is kept to 5 MB (plus agent.log.1 and .2, older)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.handlers.RotatingFileHandler(HERE / "agent.log", maxBytes=5_000_000, backupCount=2, encoding="utf-8")])
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
    single_instance()
    watch_launcher()
    log.info("agent started for %s/%s, queue folder %s", cfg["owner"], cfg["repo"], q)
    if agent.start_live():
        log.info("live status on (%s, every %ss)", cfg["firebase_url"], cfg.get("live_seconds", 5))
    while True:
        try:
            agent.tick()
        except Exception as e:                           # never die on a transient error
            log.exception("cycle failed: %s", e)
        time.sleep(cfg.get("poll_seconds", 20))


if __name__ == "__main__":
    main(sys.argv)
