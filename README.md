# Metamaterial test rig: public pattern queue

People anywhere can design an insert pattern on the web page and queue it. The rig in the lab builds and tests the patterns one at a time, whenever it is online, and posts the results. Visitors never control the hardware: they only add 105-digit patterns to a queue.

```
 web page (GitHub Pages)  --submit-->  GitHub issue  --check-->  label "queued"
        ^  status, queue, results              |
        |                                      v   (the lab computer only makes outgoing requests)
 status issue + results/  <--publish--  lab/agent.py  <--files-->  rig program + web-queue add-on  -->  robot
```

| Folder | What it is |
|---|---|
| `docs/` | The web page (static; served by GitHub Pages). Settings in `docs/assets/config.js`; the island-algorithm check is in `docs/assets/island.js`; the data set offered for download is in `docs/data/` (made by `lab/build_web_dataset.py`). |
| `.github/ISSUE_TEMPLATE/pattern.yml` | The request form the page opens, pre-filled with the pattern. |
| `.github/workflows/validate-pattern.yml` | Checks each request (105 digits, data-sharing box, at most 3 waiting per person) and labels it `queued` or `invalid`. |
| `lab/agent.py` | Runs on the rig computer. Publishes the machine status, hands queued patterns to the rig program, publishes results. |
| `lab/rig_web_queue_addon.py` | Code added to the rig program so it can run web jobs from a local folder. |
| `lab/simulate_rig.py` | A stand-in for the rig program, to test everything without the machine. |
| `results/` | One folder per tested request, plus `index.csv`. Written by the agent. |

## 1. Set up the repository (once)

1. Create a **public** repository, for example `adamslab-gibert/metamaterial-rig`, and upload all files from this folder.
2. **Settings → Pages**: source "Deploy from a branch", branch `main`, folder `/docs`. The page appears at `https://adamslab-gibert.github.io/metamaterial-rig/`.
3. Open the page with `?demo=1` at the end of the address to preview it with made-up data. Then edit `docs/assets/config.js`: `owner`, `repo`, `labName`, later `youtubeChannelId` and `datasetUrl`/`datasetDoi`.
4. Edit the page link in `.github/ISSUE_TEMPLATE/pattern.yml` and `config.yml` if your page address differs.
5. **Settings → Actions → General**: allow GitHub Actions. If the organisation restricts the workflow token to read-only, allow "Read and write permissions" (the workflow only needs to label and comment on issues).
6. Open the page, click **Submit pattern to the queue** and submit the pre-filled issue. Within a minute the bot should comment "Pattern accepted" and add the `queued` label. It also creates all the labels the system uses.

Options in `.github/workflows/validate-pattern.yml`:
- `MAX_OPEN_PER_USER` (default 3): patterns one person may have waiting.
- `REQUIRE_APPROVAL` ("true"/"false"): when "true", requests get `awaiting-approval` and a lab member swaps it for `queued` by hand.

## 2. Set up the rig computer (once)

1. **Python packages** (in the same Python as the rig program is fine): `pip install requests pillow matplotlib`
2. **A token only for this computer.** GitHub → Settings → Developer settings → *Fine-grained tokens* → Generate:
   - Resource owner: `adamslab-gibert`
   - Repository access: *Only select repositories* → `metamaterial-rig`
   - Permissions: **Issues: Read and write**, **Contents: Read and write** (Metadata read-only is added automatically)
   - Store it only on the rig computer, as an environment variable. Windows: `setx RIG_GITHUB_TOKEN "github_pat_..."` then open a new terminal. Never put it in a file in this repository or paste it into a chat.
3. Copy `lab/agent_config.example.json` to `lab/agent_config.json` and set `queue_dir` to the `web_queue` folder inside the rig program's folder (the folder of `rig_control_backend.py`, e.g. `C:/data/research/projects/ProgramME/PME/web_queue`).
4. **Add the web queue to the rig program.** Either use the ready-made `rig_control_backend_web.py` (your program with the add-on built in; keep it in the lab, it is not part of this public repository), or paste `lab/rig_web_queue_addon.py` into your program as its header explains.

## 3. Test without the machine

1. In `agent_config.json`, point `queue_dir` at a test folder, e.g. `./web_queue_test`.
2. Terminal 1: `python lab/simulate_rig.py --queue-dir ./web_queue_test --seconds 30` (add `--data <folder with the .npy files>` to replay real measured curves).
3. Terminal 2: `python lab/agent.py resume` then `python lab/agent.py run`.
4. Submit a pattern on the page. The status turns green, the request goes `queued → running → done`, a results folder appears and the page shows the curve. Delete the test results afterwards if you like.

## 4. Daily use

1. Start the rig program as usual: connect both Enders and the Mark-10, load the corner coordinates. The add-on reports "not set up" until all three are connected and the coordinates are loaded.
2. Start the agent: `python lab/agent.py run` (leave the window open; it logs to `lab/agent.log`).
3. Allow web jobs: `python lab/agent.py resume`. The page shows **Online and ready**.
4. To stop taking jobs (refilling inserts, other experiments): `python lab/agent.py pause "Back after 3 pm"`. The current test finishes; the note appears on the page. Pressing any long-running button in the rig program also holds the queue until the action ends.
5. **Halt** in the rig program stops a web job immediately; the request is marked `failed` and the queue pauses.
6. After any failure the queue pauses itself. Check the machine, then `python lab/agent.py resume`. To give a failed request another try, remove its `failed` label and add `queued`.
7. If the agent or the rig program is closed, the page shows **Offline** after about 6 minutes. Requests keep their place.

## Live camera

The rig program holds the C920 while it runs, so use a second webcam for the stream (or OBS with the C920 shared through its virtual camera). Stream it to YouTube Live with OBS, then put your channel ID (Studio → Settings → Channel → Advanced, starts with `UC`) in `youtubeChannelId` in `docs/assets/config.js`. The page embeds whatever the channel is streaming live.

## Results format

`results/<request number>/`:
- `curve.json`: `pattern` (105 digits, bottom row first), `pattern_matrix_19x11` (row 0 = top, as `codeData`), `max_displacement_mm` (displacement at 20 N, as `maxData`), `displacement_mm` and `force_N` (200 points), `dataData` (2F/20 N − 1, as the data set), `offset_N`, `status`, `tested_at`, `submitted_by`.
- `raw.csv`: every reading during loading and unloading.
- `photo_01.jpg …`: frames taken during compression. `curve.png`: plot.

`results/index.csv` lists every test. Processing follows the published data set: the offset is the median reading in the first 0.1 mm, and the curve is cut where the force minus the offset reaches 20 N.

## Safety

- The web page and the agent can only queue 105-digit patterns. Every machine command is generated by the rig program from your existing calibrated moves.
- The 20 N stop is in the rig program. The add-on also stops a test if 20 N is not reached within 45 mm (`WEB_MAX_STROKE`).
- Decide with your PI when the rig may run unattended. A simple rule to start with: resume only while someone is in the lab.

Measured data are published under CC BY 4.0.

## Data set on the web page

The top of the page counts every measured run, split into patterns that follow the island algorithm (every empty cell touches at least two separate islands) and patterns that do not, and offers the whole set for download.

- Published runs: `docs/data/` (`codeData.npy`, `dataData.npy`, `maxData.npy`, `island.npy`, `keys.txt`, `summary.json`). Rebuild them from the lab files with `python lab/build_web_dataset.py --set codeData_final.npy dataData_final.npy maxData_final.npy --set codeData.npy dataData.npy maxData.npy` (repeat `--set` for more files; each pattern is kept once, first occurrence wins), then commit and push `docs/data/`. Current build: 22,176 runs (19,662 final set + 2,514 non-island runs from the original 23,915).
- Each pattern appears once: queue runs of a pattern already in the data set, or already tested from the queue, are not added again.
- Runs tested from the queue: the agent appends each one to `results/dataset_additions.csv`. The page checks each pattern with the island rule, adds it to its group, and merges these rows into the download.

## Batches (zip upload)

Visitors can upload a `.zip` with a `patterns` file (one 105-digit pattern per line) and an `index` file (0, 1, 2 … one line per pattern), up to 100 patterns. The page checks the zip in the browser and shows either the errors (file and line) or the number of patterns, how many follow the island algorithm, and how many are already in the data set. Submitting opens one request from `.github/ISSUE_TEMPLATE/batch.yml` (patterns written as 27 hex digits each so 100 fit in the link). The checker labels it `queued`; the agent runs the patterns one after another in index order (job numbers 10 000 000 + request × 1000 + index, so the rig program needs no change), publishes each to `results/<request>/<index>/` and `results/<request>/batch.json`, and posts one summary table when the batch is finished. A failed pattern is reported and the batch continues after `agent.py resume`.

## Challenge, explorer and test replay

**Inverse-design challenge.** `docs/data/challenge.json` holds 10 target curves (at least two buckling events each, spread over the displacement at 20 N). Their patterns are left out of `docs/data/` and kept only in the lab (`challenge_targets_SECRET.json`, never in this repository). Entries use `.github/ISSUE_TEMPLATE/challenge.yml` (target, pattern, method description); the checker requires a valid target and a method of at least 20 characters. After the test, the agent scores the entry (RMS difference of the 200-point curves in N, plus the difference in displacement at 20 N), adds it to `results/leaderboard.json` and comments the score and rank. To make new targets:

    python lab/make_challenge.py --data docs/data --n 10 --public docs/data/challenge.json --secret <folder outside the repo>/challenge_targets_SECRET.json
    python lab/build_web_dataset.py --exclude <same secret file> --set ... --set ...

**Data-set explorer.** `docs/data/explorer.bin` + `explorer.json` (written by `build_web_dataset.py`): packed patterns, displacement at 20 N, 50-point curves and per-run metrics (inserts, islands, largest island, buckling events, island rule) for the scatter plot on the page.

**Test replay.** The rig program logs the reading at which each photo is taken (`images/frames.csv`); the agent publishes every photo of the loading phase (up to `max_frames`, resized to `frame_width`) with `frames.json` (displacement and force of each photo), so the page can replay a test with the photo synced to the curve. Older rig programs without `frames.csv` still work: the agent replays the photo rule (every 5 mm or 1 N) on the raw readings.

**On the rig.** The status now includes the pattern being tested and the last result, which the page shows next to the machine status.
