# Programmable metamaterial test rig

**Website: https://adamslab-gibert.github.io/metamaterial-rig/** (add `?demo=1` to any page to see it with made-up data)

The Adams Lab rig tests a silicone lattice of 105 diamond cells. A robot places a rigid insert in any chosen cell, compresses the specimen to 20 N and records the force. This repository lets anyone on the internet use the rig and its data:

- **Submit** one pattern, or a zip of up to 100, and the rig tests them when it is online.
- **Watch** the rig's status, the pattern being tested, a live video stream and the results.
- **Download and explore** the measured data set: about 22,000 patterns with their force curves.
- **Enter the inverse-design challenge:** find a pattern that reproduces a secret target curve, and appear on the leaderboard.

Visitors never control the hardware. They can only add patterns to a queue; the rig program generates every machine command from the lab's own calibrated moves.

---

## Contents

1. [How it works](#1-how-it-works)
2. [What is in this repository](#2-what-is-in-this-repository)
3. [The website](#3-the-website)
4. [Requests and the checker](#4-requests-and-the-checker)
5. [The lab computer: agent and rig program](#5-the-lab-computer-agent-and-rig-program)
6. [Results and the data set](#6-results-and-the-data-set)
7. [The inverse-design challenge](#7-the-inverse-design-challenge)
8. [Setup](#8-setup)
9. [Daily use](#9-daily-use)
10. [Maintenance tasks](#10-maintenance-tasks)
11. [Conventions and formats](#11-conventions-and-formats)
12. [Safety](#12-safety)

---

## 1. How it works

```
 visitor's browser                         GitHub                                  lab computer (rig PC)
 ─────────────────                         ──────                                  ─────────────────────
 website (GitHub Pages, docs/)
   │  submit a pattern / batch / entry
   └────────────────────────────────► request (GitHub issue)
                                            │  checker (GitHub Action) validates it,
                                            │  adds the label "queued"
                                            │
                                            │      every 20 s: "anything queued?"
                                            ◄────────────────────────────────────── lab/agent.py
                                            │                                          │ writes a job file
                                            │                                          ▼
                                            │                                      rig program + web-queue add-on
                                            │                                          │ builds and tests the pattern
                                            │                                          ▼ writes data + photos
                                            │      uploads results, comments,          │
                                            ◄────────────────────────────────────── lab/agent.py
                                            │      updates the status, closes
   ◄────────────────────────────────────────┘
 the website reads the status, queue, results, leaderboard and data from GitHub
```

- The **website** is static: plain HTML, CSS and JavaScript, with no server. Everything dynamic comes from GitHub (requests, a status request, files in `results/`) or from YouTube (the live video).
- A **request** is a GitHub issue created from a form. Visitors need a free GitHub account to submit.
- The **checker** runs on GitHub's servers every time a request is opened or edited.
- The **lab agent** runs on the rig computer. It only makes outgoing HTTPS requests to GitHub. Nothing on the internet can connect to the lab computer.
- The **rig program** never touches the internet. It exchanges small files with the agent through a local folder (`web_queue/`).

---

## 2. What is in this repository

| Path | What it does |
|---|---|
| **`docs/`** | **The website**, served by GitHub Pages from this folder. |
| `docs/index.html` | Page **Rig**: machine status, the pattern on the rig, live video, queue, recent results (with test replay). |
| `docs/submit.html` | Page **Submit**: design one pattern on a clickable lattice, or upload a zip of up to 100. |
| `docs/data.html` | Page **Data**: size of the data set (island algorithm / not), download, explorer. |
| `docs/challenge.html` | Page **Challenge**: the 10 target curves and the leaderboard. |
| `docs/assets/config.js` | **Settings for the website** (repository, lab name, YouTube channel, DOI, refresh times). |
| `docs/assets/app.js` | Main website code: editor, status, queue, results, batch-upload checker, data-set counts and download. |
| `docs/assets/extras.js` | Website code for the challenge, explorer, "on the rig" panel and test replay. |
| `docs/assets/island.js` | The island-algorithm rule (same as the lab's pattern generator), used to sort patterns into the two groups. |
| `docs/assets/style.css` | Look of the website. |
| `docs/assets/jszip.min.js` | Library that reads uploaded zips and builds the data-set download in the browser (JSZip 3.10.1, MIT). |
| `docs/assets/example_batch.zip` | Example upload (5 patterns) offered on the Submit page. |
| `docs/assets/example_challenge.zip` | Example challenge upload (entries for T1 and T2) offered on the Challenge page. |
| `docs/data/` | **The published data set** and files derived from it (see [section 6](#6-results-and-the-data-set)). Made by `lab/build_web_dataset.py`. |
| **`.github/`** | **Request forms and the checker.** |
| `.github/ISSUE_TEMPLATE/pattern.yml` | Form for one pattern. |
| `.github/ISSUE_TEMPLATE/batch.yml` | Form for a batch (up to 100 patterns). |
| `.github/ISSUE_TEMPLATE/challenge.yml` | Form for a challenge entry (target, pattern, method). |
| `.github/ISSUE_TEMPLATE/challenge_batch.yml` | Form for challenge entries uploaded as a zip (up to 10, one per target, plus a method). |
| `.github/ISSUE_TEMPLATE/config.yml` | Adds a link to the website on GitHub's "new issue" page. |
| `.github/workflows/validate-pattern.yml` | Runs the checker on every new or edited request. Settings: `MAX_OPEN_PER_USER`, `REQUIRE_APPROVAL`. |
| `.github/scripts/validate.js` | The checker itself. |
| **`lab/`** | **Code for the lab computer.** |
| `lab/agent.py` | The lab agent: status, queue, results, challenge scores. Run it on the rig computer. |
| `lab/agent_config.example.json` | Template for `lab/agent_config.json` (the agent's settings; not in the repository). |
| `lab/rig_web_queue_addon.py` | The code added to the rig program so it can run web jobs. The lab's full program with this built in (`rig_control_backend_web.py`) is kept in the lab, not here. |
| `lab/simulate_rig.py` | A stand-in for the rig program, to test the whole system without the machine. |
| `lab/build_web_dataset.py` | Builds `docs/data/` from the lab's `.npy` files (removes repeated patterns, holds out challenge targets, makes the explorer files). |
| `lab/make_challenge.py` | Chooses challenge targets and writes the public curves and the secret patterns. |
| **`results/`** | **Written by the agent:** one folder per tested request, plus `index.csv`, `dataset_additions.csv` and `leaderboard.json`. |

Not in this repository (kept in the lab): the rig program `rig_control_backend_web.py`, the agent's token and `agent_config.json`, and `challenge_targets_SECRET.json` (the answers to the challenge).

---

## 3. The website

Four pages share a top bar with the page links and a small rig-status badge.

**Rig** (`index.html`)
- *Machine status*: **Online and ready**, **Running a test** (for a batch, "pattern 5 of 12"), **Online, not taking new tests** (paused, not set up, or after a failure) or **Offline** (no update from the lab computer for 6 minutes).
- *On the rig*: the pattern being tested; after the test, its pattern and force curve, with a **Replay** button.
- *Live view*: the YouTube live stream of the lab's channel (`youtubeChannelId` in `config.js`).
- *Queue*: every waiting request with its place, size, status and an estimate of the machine time left.
- *Recent results*: the last finished requests with their curves. **Replay the test** shows the photos taken during compression, synced to a marker on the curve.

**Submit** (`submit.html`)
- *Option 1, design one pattern*: click cells to add or remove inserts, or paste a 105-digit code. It shows the number of inserts and whether the pattern follows the island algorithm. **Submit this pattern to the queue** opens a pre-filled GitHub request.
- *Option 2, upload a batch*: a zip with a `patterns` file and an `index` file (see [section 11](#11-conventions-and-formats)). The page checks it in the browser and lists every problem by file and line. If the zip is correct, it shows how many patterns, how many follow the island algorithm, how many are already in the data set, and a picture of each. **Submit N patterns to the queue** opens one GitHub request with the whole batch.
- Opened from the Challenge page (`submit.html?challenge=T3`), the editor is in challenge mode: it shows the target and a method box, and submits a challenge entry. Opened from the explorer (`submit.html?pattern=…`), it loads that pattern.

**Data** (`data.html`)
- *Size and download*: number of measured runs, split into patterns that follow the island algorithm and patterns that do not. New runs from the queue are added live. **Download the data set** builds a zip in the browser with `codeData.npy`, `dataData.npy`, `maxData.npy`, `island.npy`, `source.csv` and a `README.txt` that describes every file.
- *Explore the data set*: every run as a point. Choose the axes (displacement at 20 N, inserts, islands, largest island, buckling events) and filter. Click a point to see its pattern and curve, and open it in the editor.

**Challenge** (`challenge.html`)
- The 10 target curves, a chart of the selected target with the best entry, and the leaderboard: rank, entrant, score, displacement difference, method, date. **Design a pattern for Tn** opens the Submit page in challenge mode.
- *Work offline*: **Download the target curves** gives a zip with `targets_dataData.npy` (10 × 200, as in the data set), `targets_maxData.npy`, `targets.csv`, `targets_curves.csv` (displacement and force) and a README. Entries made with your own code are uploaded as a zip with a `patterns` file and a `targets` file (one target per line, T1–T10, same order; at most one pattern per target). The page checks the zip, shows each entry next to its target, requires a method description and opens one GitHub request (`challenge_batch.yml`).

**Website settings** (`docs/assets/config.js`)

| Setting | Meaning |
|---|---|
| `owner`, `repo`, `branch` | Where the requests and results live (this repository). |
| `labName` | Shown at the top and bottom of each page and in the download's README. |
| `youtubeChannelId` | YouTube channel ID (starts with `UC`) for the live view. Empty = placeholder text. |
| `datasetDoi` | DOI of an archived release (e.g. Zenodo). Shown under the download button when set. |
| `offlineAfterMinutes` | The rig counts as offline when its status is older than this (default 6). |
| `refreshSeconds` | How often each page refreshes (default 90). Each refresh uses one or two GitHub API calls; GitHub allows 60 per hour per visitor. |

---

## 4. Requests and the checker

Every submission is a GitHub issue made from one of three forms. The label decides the type:

| Form | Labels | Content |
|---|---|---|
| `pattern.yml` | `pattern-request` | One 105-digit pattern. |
| `batch.yml` | `pattern-request`, `batch-request` | Up to 100 patterns, one per line, in index order (as 105 digits or, as the website writes them, 27 hex digits each so 100 fit in the link). |
| `challenge.yml` | `pattern-request`, `challenge` | A target (T1–T10), one pattern and a method description (at least 20 characters). |
| `challenge_batch.yml` | `pattern-request`, `batch-request`, `challenge` | Up to 10 lines "T3 <pattern>" (one pattern per target) and one method description. Made by the zip upload on the Challenge page. |

All forms have a required data-sharing box (results are published under CC BY 4.0).

The **checker** (`.github/scripts/validate.js`, run by `.github/workflows/validate-pattern.yml`) checks:
- the patterns are valid (105 digits of 0 and 1; at most 100 for a batch);
- the data-sharing box is ticked;
- for a challenge entry, the target exists and there is a method;
- the person has fewer than `MAX_OPEN_PER_USER` (3) requests waiting.

It then adds **`queued`** (or **`awaiting-approval`** if `REQUIRE_APPROVAL` is `"true"`) or **`invalid`**, and keeps one comment on the request up to date with the result: a drawing of the pattern, the list of a batch, or what to fix. Editing the request runs the check again, until the request has started.

**Labels and their meaning**

| Label | Set by | Meaning |
|---|---|---|
| `queued` | checker | Waiting for the rig. |
| `awaiting-approval` | checker | Waiting for a lab member to swap it for `queued` (only if `REQUIRE_APPROVAL` is on). |
| `invalid` | checker | Needs fixing; see the bot's comment. |
| `running` | agent | Being tested now. |
| `done` | agent | Tested; results posted; request closed. |
| `failed` | agent | The test did not finish; a lab member will check. |
| `machine-status` | agent | The special request that holds the rig's status (locked). |

---

## 5. The lab computer: agent and rig program

### Lab agent (`lab/agent.py`)

Runs in a terminal window on the rig computer. Every 20 seconds it:

1. **Publishes the status.** It reads `web_queue/rig_status.json`, written by the rig program, and writes the state into the "Machine status" request when it changes, and at least every 2 minutes. The state includes the current job and pattern, and the last result.
2. **Hands out the next job.** It only does this when the rig is idle, set up and allowed to take web jobs. It takes the oldest `queued` request and writes `web_queue/inbox/<job>.json`, then labels the request `running` and comments "Started on the rig". A batch runs all of its patterns, in index order, before the next request starts. Each pattern is a separate job numbered `10000000 + request × 1000 + index`.
3. **Publishes finished tests.** When the rig program writes `web_queue/outbox/<job>/done.json`, the agent does the following:
   - processes the curve exactly like the data set;
   - uploads everything in one commit (see [section 6](#6-results-and-the-data-set));
   - for a challenge entry, computes the score and updates the leaderboard;
   - comments on the request with the result, labels it `done` and closes it.

   If a test failed, it labels the request `failed` and explains why. Within a batch, the failed pattern is reported and the batch continues after `resume`.

Commands:

| Command | What it does |
|---|---|
| `python lab/agent.py run` | Keep running (normal use). Logs to `lab/agent.log`. |
| `python lab/agent.py resume` | Allow web jobs (creates `web_queue/accepting`). |
| `python lab/agent.py pause "note"` | Stop taking new web jobs; the current test finishes. The note is shown on the website. |
| `python lab/agent.py status` | Print what the agent sees locally. |
| `python lab/agent.py once` | One cycle, then exit (for testing). |

Settings in `lab/agent_config.json` (copy from `agent_config.example.json`):

| Setting | Meaning |
|---|---|
| `owner`, `repo`, `branch` | This repository. |
| `token_env` | Name of the environment variable holding the GitHub token (default `RIG_GITHUB_TOKEN`). |
| `queue_dir` | The `web_queue` folder inside the rig program's folder. |
| `poll_seconds` | Cycle time (20). |
| `heartbeat_seconds` | Publish the status at least this often (120). |
| `rig_stale_seconds` | The rig program counts as closed if its status file is older than this (60). |
| `max_frames`, `frame_width` | Photos published per test (40) and their width in pixels (720). |

### Rig program with the web-queue add-on

The add-on (`lab/rig_web_queue_addon.py`, built into the lab's `rig_control_backend_web.py`) adds a timer to the rig program. Every 3 seconds the timer:
- writes `web_queue/rig_status.json`: idle, busy or error; whether the hardware is ready; whether web jobs are allowed;
- when the rig is allowed and idle, runs the oldest job in `web_queue/inbox/`.

It runs that job with the same moves as `run_test_set`:
1. Home the gantries every 10 jobs.
2. Re-place every cell every 10 jobs; otherwise change only the cells that differ from the last pattern.
3. Compress to 20 N, taking a photo every 5 mm or 1 N.
4. Unload.
5. Write `data.txt`, `code.txt`, `images/` (with `frames.csv`, the reading at which each photo was taken) and finally `done.json`.

The camera is set by `CAMERA_NAME` in the rig program. `"OBS Virtual Camera"` shares the C920 with OBS for the live stream; set it to `"C920"` to use the webcam directly.

### Folder shared by the agent and the rig program (`web_queue/`)

| File | Written by | Meaning |
|---|---|---|
| `rig_status.json` | rig program | State, every 3 s. |
| `accepting` | `agent.py resume` | Present = web jobs allowed. |
| `pause_message.txt` | `agent.py pause` | Note shown on the website. |
| `inbox/<job>.json` | agent | Next job: `{"issue": job, "pattern": "0101…"}`. |
| `running/<job>.json` | rig program | The job being run. |
| `outbox/<job>/` | rig program | Results; `done.json` is written last. |
| `archive/<job>/` | agent | Results after they were published. |
| `agent_state.json` | agent | The agent's memory (current job, batch progress, test durations). |

---

## 6. Results and the data set

### Per test: `results/<request>/` (a batch: `results/<request>/<index>/`)

| File | Content |
|---|---|
| `curve.json` | `pattern` (105 digits), `pattern_matrix_19x11`, `max_displacement_mm` (displacement at 20 N), `displacement_mm` and `force_N` (200 points), `dataData` (as in the data set), `offset_N`, `status`, `tested_at`, `submitted_by`, `frames`. |
| `raw.csv` | Every reading during loading and unloading. |
| `pattern.txt` | The 105-digit pattern. |
| `curve.png` | Plot of the curve. |
| `frames/frame_XX.jpg`, `frames.json` | Photos taken during compression, with the displacement and force at each photo (used by the replay). |
| `batch.json` | Batch only: every pattern of the batch with its status, displacement at 20 N and curve. |

Curves are processed exactly like the published data set:
1. The offset is the median reading in the first 0.1 mm.
2. The curve is cut where the force minus the offset reaches 20 N.
3. The rest is resampled to 200 points.

### Lists across all tests: `results/`

| File | Content |
|---|---|
| `index.csv` | One line per test: request, batch index, time, displacement at 20 N, status, pattern. |
| `dataset_additions.csv` | One line per successful test in data-set form (pattern, displacement, 200 `dataData` values). The website adds these to the data set. |
| `leaderboard.json` | Every scored challenge entry. |

### The published data set: `docs/data/`

| File | Content |
|---|---|
| `codeData.npy` | Patterns, N × 19 × 11, uint8. |
| `dataData.npy` | Force curves, N × 200, float32, stored as 2F/20 N − 1. |
| `maxData.npy` | Displacement at 20 N in mm, N. |
| `island.npy` | 1 if the pattern follows the island algorithm, N. |
| `keys.txt` | Each pattern as 27 hex digits, so the website can skip queue tests of patterns already in the set. |
| `summary.json` | Counts and where the rows came from. |
| `explorer.bin`, `explorer.json` | Compact copy for the explorer: patterns, displacement, 50-point curves, metrics (inserts, islands, largest island, buckling events, island rule). |
| `challenge.json` | The challenge target curves (no patterns). |

Current contents: **22,166 runs**, each pattern once. 19,654 runs follow the island algorithm and 2,512 do not.
- Source 1: the lab's final data set (19,662 runs).
- Source 2: the 2,514 early runs from the original 23,915-run set whose patterns were not in the final set. None of them follow the island algorithm.
- The 10 challenge targets are left out.

**Each pattern appears once.** When the data set is built, a repeated pattern keeps its first occurrence. On the website, a queue test of a pattern already in the set (or already tested from the queue) is shown as a result but not added again.

**The island algorithm.** A pattern follows it when every empty cell touches at least two different islands. An island is a group of inserts connected through neighbouring cells, which share an edge or a corner. This is the rule checked by the lab's pattern generator (`conforms()` in `island_generator.py`).

---

## 7. The inverse-design challenge

- **Targets.** 10 measured runs, each with at least two buckling events (force drops of more than 1.5 % of the peak). They are spread over the displacement at 20 N, from 17.8 to 37.6 mm, and 2 of them do not follow the island algorithm. The website shows only their curves (`docs/data/challenge.json`). Their patterns are kept in the lab (`challenge_targets_SECRET.json`) and left out of the data set.
- **Entry.** Either one pattern made in the editor (`challenge.yml`; the Submit page fills in the form in challenge mode), or up to 10 patterns uploaded as a zip on the Challenge page, at most one per target (`challenge_batch.yml`). Both need a method description. Uploaded entries run like a batch, one after another; each is scored against its own target, and one summary table with the scores is posted when all are done.
- **Offline work.** The Challenge page offers the target curves as a zip (NumPy and CSV) for use with your own code.
- **Score.** The paper's 200-point error, in N: the RMS difference between the submitted pattern's 200-point curve and the target's (F = (dataData + 1) × 10 N, at the same fraction of each run's displacement at 20 N). Lower is better. The difference in displacement at 20 N is reported alongside.
- **Leaderboard.** After the test, the agent writes the score to `results/leaderboard.json` and comments the score and rank on the request. The Challenge page ranks the entries for each target.

---

## 8. Setup

### Repository and website (once; done for this repository)

1. **Settings → Pages**: "Deploy from a branch", branch `main`, folder `/docs`.
2. **Settings → Actions → General**: allow all actions, and set "Workflow permissions" to **Read and write permissions** (the checker labels and comments on requests).
3. Check `docs/assets/config.js`.
4. Test: submit a pattern from the Submit page. Within a minute the bot should comment and add `queued`; the first run also creates all labels. If nothing happens, open the **Actions** tab and look at "Check pattern request".

### Rig computer (once)

1. Install Python packages: `pip install requests pillow matplotlib`
2. Create a GitHub token **for this computer only**: GitHub → Settings → Developer settings → *Fine-grained tokens* → Generate.
   - Resource owner `adamslab-gibert`; repository access *Only select repositories* → `metamaterial-rig`.
   - Permissions: **Issues: Read and write**, **Contents: Read and write**.
   - Store it as an environment variable: `setx RIG_GITHUB_TOKEN "github_pat_..."` (Windows), then open a new terminal. Never put it in a file in this repository or paste it into a chat.
3. Copy `lab/agent_config.example.json` to `lab/agent_config.json` and set `queue_dir` to the `web_queue` folder inside the rig program's folder.
4. Use the lab's `rig_control_backend_web.py` (rig program with the add-on), kept in the lab.
5. For the live stream: install OBS, add the C920 as a "Video Capture Device", set the video to 1920×1080 and click **Start Virtual Camera** *before* starting the rig program. Stream to YouTube and put the channel ID in `config.js`. Keep the OBS scene to the camera picture only: anything added in OBS also appears in the test photos.

### Test without the machine

1. In `agent_config.json`, point `queue_dir` at a test folder, e.g. `./web_queue_test`.
2. Terminal 1: `python lab/simulate_rig.py --queue-dir ./web_queue_test --seconds 30`. Options: `--data <folder>` replays real curves from `codeData/dataData/maxData.npy`; `--fail-every N` makes every Nth job fail.
3. Terminal 2: `python lab/agent.py resume`, then `python lab/agent.py run`.
4. Submit a pattern on the website. The status turns to "Running a test", the request goes `queued → running → done`, and the result appears on the Rig page.

---

## 9. Daily use

1. If you stream: start OBS and its virtual camera.
2. Start the rig program as usual: connect both Enders and the Mark-10, and load the corner coordinates. Until then the website shows "not set up".
3. Start the agent: `python lab/agent.py run` (leave the window open).
4. Allow web jobs: `python lab/agent.py resume`. The website shows **Online and ready**.
5. To stop taking jobs (refilling inserts, other experiments): `python lab/agent.py pause "Back after 3 pm"`. The current test finishes and the note appears on the website. Pressing any long-running button in the rig program also holds the queue until it ends.
6. **Halt** in the rig program stops a web job immediately: the request is marked `failed` and the queue pauses.
7. After any failure the queue pauses itself. Check the machine, then `python lab/agent.py resume`. To retry a failed request, remove its `failed` label and add `queued`.
8. If the agent or the rig program is closed, the website shows **Offline** after about 6 minutes. Requests keep their place.

---

## 10. Maintenance tasks

**Rebuild the published data set** (e.g. after adding lab runs). Earlier `--set` entries take priority when a pattern appears twice:

    python lab/build_web_dataset.py --exclude <path>/challenge_targets_SECRET.json \
        --set codeData_final.npy dataData_final.npy maxData_final.npy \
        --set codeData.npy dataData.npy maxData.npy

Then commit and push `docs/data/`. Patterns may be given as N × 19 × 11 arrays (`codeData`) or as 105-digit strings (`codeList`).

**Choose new challenge targets.** Keep the secret file outside the repository; the script refuses a path inside it. Then rebuild the data set with `--exclude` as above:

    python lab/make_challenge.py --data docs/data --n 10 \
        --public docs/data/challenge.json --secret <folder outside the repo>/challenge_targets_SECRET.json

**Require approval for every request.** Set `REQUIRE_APPROVAL: "true"` in `.github/workflows/validate-pattern.yml`. A lab member then replaces `awaiting-approval` with `queued`.

**Change how many requests one person may have waiting.** Edit `MAX_OPEN_PER_USER` in the same file.

---

## 11. Conventions and formats

**Pattern code: 105 digits, 1 = insert.** The order is bottom row first, left to right within each row:
- digits 0–5: bottom row (6 cells);
- digits 6–10: the row above (5 cells);
- and so on, up to digits 99–104: top row.

The rig program, the lab's pattern generator and the website all use this order.

**`codeData` grid: 19 × 11, row 0 = top.** Even rows hold 6 cells in columns 0, 2 … 10; odd rows hold 5 cells in columns 1, 3 … 9. All other grid positions are 0.

**Force curves.** `dataData` has 200 points at equal steps of displacement from 0 to `maxData`:
- force: F [N] = (dataData + 1) × 10;
- displacement of point k: maxData × k / 199 [mm].

**Challenge zip.** One `.zip` with `patterns` (one 105-digit pattern per line) and `targets` (one target per line, T1–T10 or 1–10, same order); at most one pattern per target, up to 10. See `docs/assets/example_challenge.zip`.

**Batch zip.** One `.zip` with two text files (`.txt` or no extension, in any folder of the zip), for up to 100 patterns:
- `patterns`: one 105-digit pattern per line.
- `index`: one line per pattern: 0, 1, 2 …, in the same order.

The patterns are tested in that order. See `docs/assets/example_batch.zip`.

---

## 12. Safety

- The website, the checker and the agent can only queue 105-digit patterns. The rig program generates every machine command from the lab's calibrated moves.
- The 20 N stop is in the rig program. A web test also stops if 20 N is not reached within 45 mm (`WEB_MAX_STROKE` in the add-on).
- Any failure pauses the queue until someone resumes it.
- Decide with the PI when the rig may run unattended. A simple rule to start with: resume only while someone is in the lab.

---

Measured data are published under **CC BY 4.0**. Run by the Adams Lab, Purdue University.
