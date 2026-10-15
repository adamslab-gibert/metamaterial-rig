/* Metamaterial test rig: pattern editor, machine status, queue and results.
   Static page; reads public data from the GitHub API and raw.githubusercontent.com.
   Add ?demo=1 to the address to see the page with made-up data. */
(function () {
  "use strict";
  const CFG = window.RIG_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has("demo");
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
  const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch || "main"}`;
  const NS = "http://www.w3.org/2000/svg";
  const N_ROWS = 19, N_CELLS = 105;
  const $id = id => document.getElementById(id);
  const PAGE = { editor: !!$id("editor"), batch: !!$id("zip-input"), status: !!$id("status"), queue: !!$id("queue-body"),
    results: !!$id("results"), dataset: !!$id("ds-total") };
  // keep ?demo=1 when moving between pages
  if (DEMO) document.querySelectorAll('a[href$=".html"], a[href*=".html#"]').forEach(a => {
    const [path, hash] = a.getAttribute("href").split("#"); a.setAttribute("href", path + "?demo=1" + (hash ? "#" + hash : ""));
  });
  const pageUrl = (file, params) => { const q = new URLSearchParams(params || {}); if (DEMO) q.set("demo", "1"); const t = q.toString(); return file + (t ? "?" + t : ""); };

  // ---------------------------------------------------------------- lattice geometry
  // Rows are numbered from the top (row 0) to the bottom (row 18). Even rows hold 6 cells
  // (columns 0, 2 ... 10), odd rows 5 cells (columns 1, 3 ... 9). The pattern code lists the
  // bottom row first, left to right, which is the order the robot uses.
  const CELLS = [];
  for (let r = 0; r < N_ROWS; r++) {
    const cols = r % 2 === 0 ? [0, 2, 4, 6, 8, 10] : [1, 3, 5, 7, 9];
    cols.forEach((c, k) => CELLS.push({ r, c, k }));
  }
  const codeIndex = new Map();          // "r,c" -> position in the code string
  { let p = 0;
    for (let r = N_ROWS - 1; r >= 0; r--) {
      const cols = r % 2 === 0 ? [0, 2, 4, 6, 8, 10] : [1, 3, 5, 7, 9];
      cols.forEach(c => codeIndex.set(r + "," + c, p++));
    } }
  const idx = cell => codeIndex.get(cell.r + "," + cell.c);
  const diamond = (c, r, s = 1) => `M${c} ${r - s}L${c + s} ${r}L${c} ${r + s}L${c - s} ${r}Z`;

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function drawLattice(svg, bits, opts = {}) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", "-1.55 -2 13.1 22");
    el("rect", { class: "plate", x: -1.3, y: -1.75, width: 12.6, height: .75, rx: .12 }, svg);
    el("rect", { class: "plate", x: -1.3, y: 19, width: 12.6, height: .75, rx: .12 }, svg);
    const nodes = [];
    CELLS.forEach(cell => {
      const on = bits[idx(cell)] === 1;
      const g = el("g", { class: "cell" + (on ? " on" : "") }, svg);
      el("path", { d: diamond(cell.c, cell.r) }, g);
      el("path", { class: "core", d: diamond(cell.c, cell.r, .62) }, g);
      if (opts.interactive) {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.dataset.i = idx(cell);
        g.setAttribute("aria-pressed", on ? "true" : "false");
        g.setAttribute("aria-label", `Row ${cell.r + 1} from the top, cell ${cell.k + 1}`);
      }
      nodes.push(g);
    });
    return nodes;
  }

  function thumb(bits, cls = "thumb") {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "lattice " + cls);
    svg.setAttribute("aria-hidden", "true");
    drawLattice(svg, bits);
    return svg;
  }

  // ---------------------------------------------------------------- editor
  let bits = new Array(N_CELLS).fill(0);
  const challenge = { target: null, method: "" };      // set by the challenge section (extras.js)
  const svg = document.getElementById("editor");
  const codeBox = document.getElementById("code");
  const codeMsg = document.getElementById("code-msg");
  const submit = document.getElementById("submit");
  let cellNodes = [];

  function render(fromText) {
    cellNodes.forEach(g => {
      const on = bits[+g.dataset.i] === 1;
      g.classList.toggle("on", on);
      g.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const n = bits.reduce((a, b) => a + b, 0);
    document.getElementById("count").textContent = n;
    document.getElementById("empty").textContent = N_CELLS - n;
    const isl = window.RigIsland ? window.RigIsland.classify(bits) : null;
    document.getElementById("island-now").textContent = isl === null ? "–" : isl ? "Follows" : "Does not";
    if (!fromText) { codeBox.value = bits.join(""); codeMsg.textContent = ""; codeMsg.classList.remove("bad"); }
    const newIssue = `https://github.com/${CFG.owner}/${CFG.repo}/issues/new?`;
    if (challenge.target) {
      submit.href = newIssue + `template=challenge.yml&title=${encodeURIComponent(`Challenge ${challenge.target}: ${n} inserts`)}` +
        `&target=${challenge.target}&pattern=${bits.join("")}` + (challenge.method ? `&method=${encodeURIComponent(challenge.method.slice(0, 1500))}` : "");
      submit.textContent = `Submit to challenge ${challenge.target}`;
    } else {
      submit.href = newIssue + `template=pattern.yml&title=${encodeURIComponent(`Pattern request: ${n} inserts`)}&pattern=${bits.join("")}`;
      submit.textContent = "Submit this pattern to the queue";
    }
    if (window.RigExtras && window.RigExtras.onPattern) window.RigExtras.onPattern(bits);
    submit.removeAttribute("aria-disabled");
    try { localStorage.setItem("rig-pattern", bits.join("")); } catch (e) { /* storage unavailable */ }
  }

  function setupEditor() {
    cellNodes = drawLattice(svg, bits, { interactive: true });
    let painting = null;
    const apply = g => {
      const i = +g.dataset.i;
      if (bits[i] !== painting) { bits[i] = painting; render(); }
    };
    svg.addEventListener("pointerdown", e => {
      const g = e.target.closest(".cell"); if (!g) return;
      e.preventDefault();
      painting = bits[+g.dataset.i] ? 0 : 1;
      apply(g);
    });
    svg.addEventListener("pointermove", e => {
      if (painting === null) return;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const g = t && t.closest && t.closest("#editor .cell");
      if (g) apply(g);
    });
    window.addEventListener("pointerup", () => { painting = null; });
    svg.addEventListener("keydown", e => {
      const g = e.target.closest(".cell"); if (!g) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault(); const i = +g.dataset.i; bits[i] = bits[i] ? 0 : 1; render();
      }
    });
    document.getElementById("btn-clear").onclick = () => { bits.fill(0); render(); };
    document.getElementById("btn-invert").onclick = () => { bits = bits.map(b => 1 - b); render(); };
    document.getElementById("btn-random").onclick = () => { bits = bits.map(() => (Math.random() < .5 ? 1 : 0)); render(); };
    codeBox.addEventListener("input", () => {
      const digits = codeBox.value.replace(/[^01]/g, "");
      const junk = codeBox.value.replace(/[01\s]/g, "");
      if (junk.length) { show(`Use only 0 and 1. Remove: ${[...new Set(junk)].join(" ")}`); return; }
      if (digits.length !== N_CELLS) { show(`${digits.length} of 105 digits`); submit.setAttribute("aria-disabled", "true"); return; }
      bits = [...digits].map(Number); render(true); codeMsg.textContent = "Pattern loaded."; codeMsg.classList.remove("bad");
    });
    function show(m) { codeMsg.textContent = m; codeMsg.classList.add("bad"); }
    let saved = null;
    try { saved = localStorage.getItem("rig-pattern"); } catch (e) { /* ignore */ }
    // first visit: start from a pattern that was measured on the rig
    const EXAMPLE = "011010010101001011010111010011000111011110110100110010010110001101101011001010100110010110001101011101011";
    const fromUrl = new URLSearchParams(location.search).get("pattern");      // e.g. from the explorer
    bits = [...(fromUrl && /^[01]{105}$/.test(fromUrl) ? fromUrl : saved && /^[01]{105}$/.test(saved) ? saved : EXAMPLE)].map(Number);
    render();
  }

  // ---------------------------------------------------------------- helpers
  function ago(t) {
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 90) return "just now";
    const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
    const h = m / 60; if (h < 36) return `${Math.round(h)} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  function patternFromBody(body) {
    if (!body) return null;
    const sec = body.split(/^###\s+/m).find(s => /^pattern/i.test(s));
    const text = sec ? sec.replace(/^.*\n/, "") : body;
    const m = text.replace(/[ \t\r\n,]/g, "").match(/[01]{105}/);
    return m ? [...m[0]].map(Number) : null;
  }
  function statusFromBody(body) {
    const m = body && body.match(/```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  const hasLabel = (i, name) => (i.labels || []).some(l => (l.name || l) === name);

  async function gh(path) {
    const r = await fetch(API + path, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 403 || r.status === 429) {
      const reset = +r.headers.get("x-ratelimit-reset");
      const err = new Error("rate");
      err.when = reset ? new Date(reset * 1000) : null; throw err;
    }
    if (r.status === 404) throw new Error("missing");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  }

  // ---------------------------------------------------------------- status + queue
  const statusBox = $id("status");
  function setStatus(state, title, detail) {
    const pill = $id("rig-pill");
    if (pill) { pill.dataset.state = state; $id("rig-pill-text").textContent = "Rig: " + title.replace(/^Online, not taking new tests$/, "Paused").replace(/^Online and ready$/, "Online"); pill.title = detail || ""; }
    if (!statusBox) return;
    statusBox.dataset.state = state;
    $id("status-title").textContent = title;
    $id("status-detail").textContent = detail || "";
  }

  let lastStatus = null;
  const inQueue = i => hasLabel(i, "queued") || hasLabel(i, "running") || hasLabel(i, "awaiting-approval");
  function showStatus(issues) {
    const st = issues.find(i => hasLabel(i, "machine-status"));
    const queued = issues.filter(inQueue);
    const s = st ? statusFromBody(st.body) : null;
    const updated = s && s.updated ? s.updated : st && st.updated_at;
    const stale = !updated || (Date.now() - new Date(updated).getTime()) > (CFG.offlineAfterMinutes || 6) * 60000;
    lastStatus = s && !stale ? s : null;
    if (window.RigExtras && window.RigExtras.onStatus) window.RigExtras.onStatus(s, stale);
    const per = s && s.minutes_per_test ? ` A test takes about ${Math.round(s.minutes_per_test)} min.` : "";
    if (!s || stale) {
      setStatus("offline", "Offline", (updated ? `Last seen ${ago(updated)}. ` : "") +
        "You can still submit patterns; they wait in the queue until the machine is back.");
    } else if (s.state === "ready") {
      setStatus("ready", "Online and ready", (queued.length ? "The next request in the queue starts shortly." : "Submit a pattern and it starts within a few minutes.") + per);
    } else if (s.state === "busy") {
      const what = s.batch_index != null ? `Testing batch #${s.job}: pattern ${s.batch_index + 1}${s.batch_total ? " of " + s.batch_total : ""}.`
        : s.job ? `Testing pattern #${s.job}.` : "";
      setStatus("busy", "Running a test", what + per);
    } else {
      setStatus("paused", "Online, not taking new tests", s.message || "The operator has paused the queue. Submitted patterns keep their place.");
    }
    return queued;
  }

  function queueMessage(text) {
    const body = $id("queue-body");
    if (!body) return;
    body.innerHTML = "";
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 5; td.className = "empty-note"; td.textContent = text;
    tr.appendChild(td); body.appendChild(tr);
  }

  function showQueue(queued) {
    const body = $id("queue-body"), sum = $id("queue-sum");
    if (!body) return;
    const running = queued.filter(i => hasLabel(i, "running"));
    const waiting = queued.filter(i => !hasLabel(i, "running")).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const rows = [...running, ...waiting];
    if (!rows.length) {
      sum.textContent = "Empty";
      queueMessage("The queue is empty. Submit a pattern or a batch above and it will be first in line.");
      return;
    }
    body.innerHTML = "";
    let patternsLeft = 0;
    rows.forEach((i, k) => {
      const isRun = hasLabel(i, "running"), isBatch = hasLabel(i, "batch-request");
      const size = isBatch ? (batchSize(i.body) || 0) : 1;
      const p = isBatch ? null : patternFromBody(i.body);
      const prog = isRun && isBatch && lastStatus && lastStatus.job === i.number && lastStatus.batch_index != null ? lastStatus.batch_index : null;
      patternsLeft += prog != null ? size - prog : size;
      const tr = document.createElement("tr");
      if (isRun) tr.className = "running";
      const td = (cls, label) => { const c = document.createElement("td"); c.className = cls; c.dataset.label = label; tr.appendChild(c); return c; };

      td("q-pos", "Place").textContent = isRun ? "Now" : (k + 1 - running.length);

      const req = document.createElement("div"); req.className = "q-req-in";
      td("q-req", "Request").appendChild(req);
      if (p) req.appendChild(thumb(p));
      else { const ic = document.createElement("span"); ic.className = "batch-icon"; ic.textContent = size; ic.setAttribute("aria-hidden", "true"); req.appendChild(ic); }
      const who = document.createElement("div");
      const a = document.createElement("a"); a.href = i.html_url; a.textContent = `#${i.number}`; who.appendChild(a);
      const by = document.createElement("span"); by.className = "sub"; by.textContent = `by ${i.user ? i.user.login : "unknown"}`; who.appendChild(by);
      req.appendChild(who);

      td("q-n", "Patterns").textContent = isBatch ? `Batch of ${size || "?"}` : `1 pattern, ${p ? p.reduce((x, y) => x + y, 0) : "?"} inserts`;

      const chip = document.createElement("span"); chip.className = "chip";
      if (isRun) { chip.classList.add("run"); chip.textContent = prog != null ? `Testing ${prog + 1} of ${size}` : "Testing now"; }
      else if (hasLabel(i, "awaiting-approval")) { chip.classList.add("wait"); chip.textContent = "Waiting for approval"; }
      else chip.textContent = "Waiting";
      td("q-st", "Status").appendChild(chip);

      td("q-when", "Submitted").textContent = ago(i.created_at);
      body.appendChild(tr);
    });
    const per = lastStatus && lastStatus.minutes_per_test;
    const hours = per ? patternsLeft * per / 60 : null;
    sum.textContent = `${rows.length} request${rows.length === 1 ? "" : "s"} · ${patternsLeft} pattern${patternsLeft === 1 ? "" : "s"} to test` +
      (hours ? ` · about ${hours < 1 ? Math.max(1, Math.round(hours * 60)) + " min" : (Math.round(hours * 10) / 10) + " h"} of machine time` : "");
  }

  // ---------------------------------------------------------------- results
  function chart(curve) {
    const W = 260, H = 160, L = 30, B = 26, T = 8, R = 8;
    const d = curve.displacement_mm, f = curve.force_N;
    const xmax = Math.max(5, Math.ceil(Math.max(...d) / 5) * 5), ymax = 20;
    const X = v => L + (W - L - R) * v / xmax, Y = v => H - B - (H - B - T) * v / ymax;
    const s = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `Force against displacement for pattern ${curve.issue}: 20 N reached at ${curve.max_displacement_mm.toFixed(1)} mm` });
    [0, 10, 20].forEach(v => {
      el("line", { class: v ? "grid" : "axis", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, s);
      el("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, s).textContent = v;
    });
    for (let v = 0; v <= xmax; v += xmax > 20 ? 10 : 5)
      el("text", { x: X(v), y: H - B + 15, "text-anchor": "middle" }, s).textContent = v;
    el("text", { x: W - R, y: H - 1, "text-anchor": "end" }, s).textContent = "displacement (mm)";
    el("text", { x: L + 4, y: T + 2, "text-anchor": "start" }, s).textContent = "force (N)";
    el("path", { class: "line", d: d.map((v, k) => (k ? "L" : "M") + X(v).toFixed(1) + " " + Y(f[k]).toFixed(1)).join("") }, s);
    const dot = el("circle", { r: 4, fill: "var(--curve)", stroke: "var(--sheet)", "stroke-width": 2, visibility: "hidden" }, s);
    const tip = el("text", { x: W - R, y: T + 2, "text-anchor": "end", visibility: "hidden" }, s);
    s.addEventListener("pointermove", e => {
      const box = s.getBoundingClientRect();
      const xv = ((e.clientX - box.left) * W / box.width - L) / (W - L - R) * xmax;
      let k = 0; while (k < d.length - 1 && d[k] < xv) k++;
      dot.setAttribute("cx", X(d[k])); dot.setAttribute("cy", Y(f[k])); dot.setAttribute("visibility", "visible");
      tip.textContent = `${d[k].toFixed(1)} mm, ${f[k].toFixed(1)} N`; tip.setAttribute("visibility", "visible");
    });
    s.addEventListener("pointerleave", () => { dot.setAttribute("visibility", "hidden"); tip.setAttribute("visibility", "hidden"); });
    return s;
  }

  async function showResults(done) {
    const box = $id("results");
    if (!box) return;
    box.innerHTML = "";
    if (!done.length) { box.innerHTML = '<p class="empty-note">No results yet. The first finished test will appear here.</p>'; return; }
    for (const i of done) {
      let curve = null;
      if (hasLabel(i, "batch-request") && !DEMO) {
        try { showBatchResult(box, i, await (await fetch(`${RAW}/results/${i.number}/batch.json`)).json()); } catch (e) { /* not published */ }
        continue;
      }
      try {
        curve = DEMO ? demoCurve(i.number) : await (await fetch(`${RAW}/results/${i.number}/curve.json`)).json();
      } catch (e) { continue; }
      const fig = document.createElement("figure"); fig.className = "result";
      const cap = document.createElement("figcaption");
      const p = patternFromBody(i.body) || (curve.pattern ? [...curve.pattern].map(Number) : null);
      if (p) cap.appendChild(thumb(p));
      const a = document.createElement("a"); a.href = i.html_url; a.textContent = `#${i.number}`; cap.appendChild(a);
      const sp = document.createElement("span");
      sp.textContent = `20 N at ${curve.max_displacement_mm.toFixed(1)} mm, ${ago(i.closed_at || i.updated_at)}`;
      cap.appendChild(sp);
      fig.appendChild(cap); fig.appendChild(chart(curve));
      if (curve.frames && window.RigExtras) {
        const b = document.createElement("button"); b.type = "button"; b.className = "replay-btn";
        b.textContent = `Replay the test (${curve.frames} photos)`;
        b.onclick = () => window.RigExtras.openReplay({ title: `Request #${i.number}`, curve, base: `${RAW}/results/${i.number}/`, issue: i.number });
        fig.appendChild(b);
      }
      box.appendChild(fig);
    }
  }

  // ---------------------------------------------------------------- data set: counts and download
  // Published runs: docs/data/ (summary.json and .npy files made by lab/build_web_dataset.py).
  // Runs tested from the queue: results/dataset_additions.csv, one line per run (written by lab/agent.py).
  // Every queue run is checked with the island rule (island.js) and counted in its group; the download
  // merges both into one set of .npy files in the visitor's browser.
  const DATA = "data/";
  let base = null, additions = [];

  function parseAdditions(text) {
    const lines = text.trim().split(/\r?\n/);
    lines.shift();
    return lines.map(l => {
      const [issue, tested_at, mx, pattern, curve] = l.split(",");
      const bits = [...(pattern || "")].map(Number);
      const data = (curve || "").trim().split(/\s+/).map(Number);
      if (bits.length !== N_CELLS || data.length !== 200 || data.some(isNaN) || isNaN(+mx)) return null;
      return { issue: +issue, tested_at, max: +mx, bits, data, island: window.RigIsland.classify(bits) === true };
    }).filter(Boolean);
  }

  async function loadDataset() {
    if (!base) {
      try {
        const r = await fetch(DATA + "summary.json", { cache: "no-cache" });
        base = r.ok ? await r.json() : null;
      } catch (e) { base = null; }
      if (!base) base = DEMO ? { runs: 22176, island: 19662, other: 2514, demo: true } : { runs: 0, island: 0, other: 0, missing: true };
    }
    if (DEMO) { additions = demoAdditions(); return; }
    const r = await fetch(`${RAW}/results/dataset_additions.csv`, { cache: "no-cache" });
    if (r.ok) additions = await uniqueAdditions(parseAdditions(await r.text()));
    else if (r.status !== 404) throw new Error("additions " + r.status);
  }

  // Each pattern appears once in the data set: a queue run is skipped when its pattern is already in
  // the published set (data/keys.txt, loaded only when there are queue runs) or earlier in the queue.
  let baseKeys = null;
  const keyOf = bits => BigInt("0b" + bits.join("")).toString(16).padStart(27, "0");
  async function uniqueAdditions(rows) {
    if (!rows.length) return rows;
    if (!baseKeys && !base.missing) {
      const r = await fetch(DATA + "keys.txt");
      if (!r.ok) throw new Error("keys " + r.status);
      baseKeys = new Set((await r.text()).split(/\s+/).filter(Boolean));
    }
    const seen = new Set(baseKeys || []);
    repeats = 0;
    return rows.sort((a, b) => new Date(a.tested_at) - new Date(b.tested_at)).filter(a => {
      const k = keyOf(a.bits);
      if (seen.has(k)) { repeats++; return false; }
      seen.add(k); return true;
    });
  }
  let repeats = 0;

  const fmt = n => n.toLocaleString("en-US");
  function showDataset() {
    if (!PAGE.dataset) return;
    const ai = additions.filter(a => a.island).length, ao = additions.length - ai;
    const isl = (base.island || 0) + ai, oth = (base.other || 0) + ao, tot = isl + oth;
    const pct = v => tot ? (100 * v / tot) : 0;
    if (base.missing) {                 // data files not uploaded yet: don't show a misleading 0
      ["ds-total", "ds-island", "ds-other"].forEach(id => { document.getElementById(id).textContent = "–"; });
      ["ds-island-sub", "ds-other-sub"].forEach(id => { document.getElementById(id).textContent = ""; });
      document.getElementById("ds-download").disabled = true;
      document.getElementById("ds-download-note").textContent = "The counts and the download appear here once the data files are uploaded.";
      return;
    }
    document.getElementById("ds-total").textContent = fmt(tot);
    document.getElementById("ds-island").textContent = fmt(isl);
    document.getElementById("ds-other").textContent = fmt(oth);
    const sub = (v, a) => `${pct(v).toFixed(1)}% of runs` + (a ? ` · ${fmt(a)} added from the queue` : "");
    document.getElementById("ds-island-sub").textContent = sub(isl, ai);
    document.getElementById("ds-other-sub").textContent = sub(oth, ao);
    const bar = document.getElementById("ds-bar");
    bar.querySelector(".isl").style.flexBasis = pct(isl) + "%";
    bar.querySelector(".oth").style.flexBasis = pct(oth) + "%";
    const btn = document.getElementById("ds-download"), note = document.getElementById("ds-download-note");
    if (base.missing) {
      btn.disabled = true;
      note.textContent = "The published runs will be counted here and become downloadable once the data files are uploaded.";
    } else if (base.demo) {
      btn.disabled = true;
      note.textContent = "Example numbers (demo mode). The download works on the live page.";
    } else if (!window.JSZip) {
      btn.disabled = true;
      note.textContent = "The download needs a script that did not load. Reload the page to try again.";
    } else if (!downloading) {
      btn.disabled = false;
      note.textContent = `${fmt(tot)} runs: patterns, force curves and displacements as NumPy files, ` +
        `including ${additions.length ? "the " + fmt(additions.length) + " new patterns" : "every new pattern"} tested from the queue so far. Each pattern appears once` +
        (repeats ? ` (${fmt(repeats)} queue test${repeats > 1 ? "s" : ""} of patterns already in the set ${repeats > 1 ? "are" : "is"} not added again)` : "") + ". CC BY 4.0.";
    }
  }

  // --- minimal .npy reader and writer (C order, little-endian)
  const NPY_TYPES = { f8: Float64Array, f4: Float32Array, i1: Int8Array, u1: Uint8Array, b1: Uint8Array,
    i2: Int16Array, u2: Uint16Array, i4: Int32Array, u4: Uint32Array, i8: BigInt64Array, u8: BigUint64Array };
  function npyRead(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf);
    if (b[0] !== 0x93 || String.fromCharCode(...b.slice(1, 6)) !== "NUMPY") throw new Error("not a .npy file");
    const major = b[6], hl = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true), off = major === 1 ? 10 : 12;
    const head = new TextDecoder().decode(b.slice(off, off + hl));
    const descr = head.match(/'descr':\s*'([^']+)'/)[1];
    if (/True/.test(head.match(/'fortran_order':\s*(\w+)/)[1])) throw new Error("Fortran order not supported");
    const shape = head.match(/'shape':\s*\(([^)]*)\)/)[1].split(",").map(s => s.trim()).filter(Boolean).map(Number);
    if (descr[0] === ">") throw new Error("big-endian .npy not supported");
    if (!NPY_TYPES[descr.slice(1)]) throw new Error("unsupported type " + descr);
    return { descr, shape, bytes: b.slice(off + hl) };
  }
  function npyEncode(descr, values) {
    const T = NPY_TYPES[descr.slice(1)], big = T === BigInt64Array || T === BigUint64Array;
    return new Uint8Array(new T(values.map(v => big ? BigInt(Math.round(v)) : v)).buffer);
  }
  function npyWrite(descr, shape, parts) {
    const sh = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
    let head = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${sh}, }`;
    head += " ".repeat(63 - ((10 + head.length) % 64)) + "\n";
    const pre = new Uint8Array(10 + head.length);
    pre.set([0x93, 78, 85, 77, 80, 89, 1, 0]);
    new DataView(pre.buffer).setUint16(8, head.length, true);
    pre.set(new TextEncoder().encode(head), 10);
    return new Blob([pre, ...parts]);
  }
  function matrixOf(bits) {            // 105-digit order -> 19 x 11, row 0 = top (codeData convention)
    const m = [];
    for (let r = 0; r < N_ROWS; r++) for (let c = 0; c < 11; c++) {
      const i = codeIndex.get(r + "," + c);
      m.push(i === undefined ? 0 : bits[i]);
    }
    return m;
  }

  // README.txt for the download: what every file holds, its shape, type, units and conventions.
  function datasetReadme({ n, n0, add, islN, date, C, D, M, I }) {
    const t = d => ({ "|u1": "uint8", "<u1": "uint8", "|b1": "bool", "<f4": "float32", "<f8": "float64", "<i8": "int64", "<i4": "int32" }[d] || d);
    const site = `https://${CFG.owner}.github.io/${CFG.repo}/`, repoUrl = `https://github.com/${CFG.owner}/${CFG.repo}`;
    const sets = (base.sets || []).map((st, k) => `  ${k + 1}. ${st.description || st.files.join(", ")}\n     ${fmt(st.runs_added)} runs added (from ${fmt(st.rows_in_files)} rows in ${st.files.join(", ")}).`).join("\n");
    const rule = "=".repeat(78), line = "-".repeat(78);
    const shp = sh => sh.length === 1 ? `(${sh[0]},)` : `(${sh.join(", ")})`;
    return `PROGRAMMABLE METAMATERIAL DATA SET
${rule}
${CFG.labName || ""}, Purdue University. Downloaded ${date} from ${site}
License: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Please cite the data set
${CFG.datasetDoi ? "(DOI " + CFG.datasetDoi + ") " : ""}and link to ${repoUrl} when you use it.

CONTENTS
  ${fmt(n)} measured runs, one row per run, every pattern appears once.
  ${fmt(n0)} from the published set + ${fmt(add.length)} tested from the public queue up to ${date}.
  ${fmt(islN)} patterns follow the island algorithm, ${fmt(n - islN)} do not (see island.npy).

  All .npy files have the same number of rows (${fmt(n)}) in the same order: row i of every
  file describes the same run. Row numbers start at 0.

THE SPECIMEN AND THE TEST
${line}
  A silicone (Mold Star 15) diamond lattice with 105 cells in 19 staggered rows between two
  solid plates. A robot places a rigid insert in any chosen cell. The rig then compresses the
  specimen at constant speed until the force reaches 20 N and records force and displacement.
  Each run's curve is processed the same way: the force offset is the median reading in the
  first 0.1 mm, and the curve is cut where (force - offset) reaches 20 N.

FILES
${line}
codeData.npy     shape ${shp([n, ...C.shape.slice(1)])}, ${t(C.descr)}
  The insert pattern of each run as a 19 x 11 grid. 1 = cell has an insert, 0 = empty.
  Row 0 is the TOP row of the specimen, row 18 the bottom row.
  The lattice is staggered, so only 105 of the 209 grid positions are real cells:
    even rows (0, 2, ..., 18) have 6 cells, in columns 0, 2, 4, 6, 8, 10
    odd rows  (1, 3, ..., 17) have 5 cells, in columns 1, 3, 5, 7, 9
  All other grid positions are always 0.

  The rig and the web page write a pattern as a 105-digit code instead. Code position p
  runs from the BOTTOM row up, left to right within each row:
    p = 0..5   -> row 18, columns 0,2,4,6,8,10
    p = 6..10  -> row 17, columns 1,3,5,7,9
    ...
    p = 99..104 -> row 0, columns 0,2,4,6,8,10

dataData.npy     shape ${shp([n, ...D.shape.slice(1)])}, ${t(D.descr)}
  The force-displacement curve of each run, 200 points at equal steps of displacement
  from 0 to maxData[i]. Stored scaled to [-1, 1]:
    dataData = 2 * F / 20 N - 1      so      F [N] = (dataData + 1) * 10
  Point 0 is at zero displacement (F about 0 N); point 199 is where the force reached
  20 N (dataData about 1). Small departures from -1 and 1 come from the offset removal.

maxData.npy      shape ${shp([n])}, ${t(M.descr)}
  The compression in millimetres at which the force reached 20 N. Displacement of point k:
    u_k [mm] = maxData[i] * k / 199,   k = 0..199

island.npy       shape ${shp([n])}, ${t(I.descr)}
  1 if the pattern follows the island algorithm, 0 if not. A pattern follows it when every
  EMPTY cell touches at least two different islands. An island is a group of inserts
  connected through neighbouring cells; neighbours share an edge or a corner (up to 8 per
  cell; in code positions p: p-11, p-6, p-5, p-1, p+1, p+5, p+6, p+11, fewer at the
  ends of rows and at the top and bottom). This is the rule checked by the lab's pattern
  generator (island_generator.py, conforms()).

source.csv       ${fmt(n)} rows + header
  Where each row came from. Columns:
    row            row number in the .npy files (0-based)
    source         "published" (the lab's data set) or "queue" (tested from the web page)
    queue_request  for queue runs: the request number on GitHub. The request is at
                     ${repoUrl}/issues/<number>
                   and its results, raw readings and photos are in
                     ${repoUrl}/tree/main/results/<number>
    tested_at      for queue runs: date and time of the test (UTC)

README.txt       this file

WHERE THE PUBLISHED ROWS COME FROM
${line}
${sets || "  The lab's published data set."}
  Repeated patterns were removed: when a pattern occurred more than once, the first
  occurrence above was kept. Queue runs of a pattern already in the data set are not
  added again.

LOADING THE FILES
${line}
  Python:
    import numpy as np
    C = np.load("codeData.npy"); D = np.load("dataData.npy")
    M = np.load("maxData.npy");  I = np.load("island.npy")
    F = (D + 1) * 10                                  # force in N, shape (N, 200)
    U = M[:, None] * np.linspace(0, 1, 200)           # displacement in mm, shape (N, 200)

  MATLAB (with npy-matlab, https://github.com/kwikteam/npy-matlab):
    C = readNPY('codeData.npy');  D = readNPY('dataData.npy');
    M = readNPY('maxData.npy');   F = (D + 1) * 10;
    U = M .* linspace(0, 1, 200);
    % MATLAB indices start at 1: Python row i is MATLAB row i + 1.
`;
  }

  let downloading = false;
  async function downloadDataset() {
    const btn = document.getElementById("ds-download"), note = document.getElementById("ds-download-note");
    downloading = true; btn.disabled = true; btn.textContent = "Preparing the download…";
    try {
      const names = ["codeData.npy", "dataData.npy", "maxData.npy", "island.npy"];
      const files = await Promise.all(names.map(async f => {
        const r = await fetch(DATA + f); if (!r.ok) throw new Error(f + " missing");
        return npyRead(await r.arrayBuffer());
      }));
      const [C, D, M, I] = files, n0 = C.shape[0], add = additions, n = n0 + add.length;
      const zip = new JSZip();
      zip.file("codeData.npy", npyWrite(C.descr, [n, ...C.shape.slice(1)], [C.bytes, npyEncode(C.descr, add.flatMap(a => matrixOf(a.bits)))]));
      zip.file("dataData.npy", npyWrite(D.descr, [n, ...D.shape.slice(1)], [D.bytes, npyEncode(D.descr, add.flatMap(a => a.data))]));
      zip.file("maxData.npy", npyWrite(M.descr, [n], [M.bytes, npyEncode(M.descr, add.map(a => a.max))]));
      zip.file("island.npy", npyWrite(I.descr, [n], [I.bytes, npyEncode(I.descr, add.map(a => a.island ? 1 : 0))]));
      let src = "row,source,queue_request,tested_at\n";
      for (let k = 0; k < n0; k++) src += `${k},published,,\n`;
      add.forEach((a, k) => { src += `${n0 + k},queue,${a.issue},${a.tested_at}\n`; });
      zip.file("source.csv", src);
      const date = new Date().toISOString().slice(0, 10);
      const islN = (base.island || 0) + add.filter(a => a.island).length;
      zip.file("README.txt", datasetReadme({ n, n0, add, islN, date, C, D, M, I }));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `metamaterial-dataset-${date}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      note.textContent = `Downloaded ${fmt(n)} runs (${(blob.size / 1e6).toFixed(1)} MB).`;
    } catch (e) {
      note.textContent = "The download could not be prepared (" + e.message + "). Please try again.";
    }
    downloading = false; btn.disabled = false; btn.textContent = "Download the data set";
  }
  if ($id("ds-download")) $id("ds-download").addEventListener("click", downloadDataset);

  // ---------------------------------------------------------------- batch upload (zip with patterns + index)
  // The zip must hold a file called "patterns" (one 105-digit pattern per line) and a file called "index"
  // (0, 1, 2 ... one number per line, one per pattern). Extensions such as .txt are fine; other files are
  // ignored. The check runs in the browser; nothing is uploaded until the visitor submits the request.
  const MAX_BATCH = 100;
  const MAX_SHOWN_ERRORS = 8;

  function linesOf(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();     // trailing blank lines are fine
    return lines;
  }

  async function checkZip(file) {
    const errors = [], warnings = [];
    if (!window.JSZip) return { errors: ["The checker could not load. Reload the page and try again."] };
    if (!/\.zip$/i.test(file.name)) errors.push(`"${file.name}" is not a .zip file. Put the patterns and index files in a zip and upload that.`);
    let zip;
    try { zip = await JSZip.loadAsync(file); }
    catch (e) { return { errors: errors.length ? errors : [`"${file.name}" could not be opened as a zip file. It may be damaged.`] }; }
    const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
    const baseName = f => f.name.split("/").pop().replace(/\.(txt|csv|dat)$/i, "").toLowerCase();
    const found = entries.map(f => f.name.split("/").pop());
    const pick = want => {
      const m = entries.filter(f => baseName(f) === want);
      if (!m.length) { errors.push(`The zip has no file called "${want}". ` + (found.length ? `It contains: ${found.slice(0, 8).join(", ")}${found.length > 8 ? " …" : ""}.` : "It is empty.")); return null; }
      if (m.length > 1) { errors.push(`The zip has ${m.length} files called "${want}" (${m.map(f => f.name).join(", ")}). Keep only one.`); return null; }
      return m[0];
    };
    const pf = pick("patterns"), xf = pick("index");
    if (!pf || !xf) return { errors };

    // patterns
    const plines = linesOf(await pf.async("string"));
    const codes = [];
    if (!plines.length) errors.push(`The patterns file is empty.`);
    plines.forEach((raw, k) => {
      const l = raw.replace(/[\s,]/g, "");
      const where = `patterns, line ${k + 1}`;
      if (!l) errors.push(`${where} is empty. Each line must hold one pattern.`);
      else if (/[^01]/.test(l)) errors.push(`${where} contains characters other than 0 and 1 (${[...new Set(l.replace(/[01]/g, ""))].slice(0, 5).join(" ")}).`);
      else if (l.length !== N_CELLS) errors.push(`${where} has ${l.length} digits; a pattern needs exactly ${N_CELLS}.`);
      codes.push(l);
    });
    if (plines.length > MAX_BATCH) errors.push(`The patterns file has ${plines.length} patterns. At most ${MAX_BATCH} can be tested per upload; split them into several zips.`);

    // index
    const xlines = linesOf(await xf.async("string"));
    if (!xlines.length) errors.push(`The index file is empty.`);
    xlines.forEach((raw, k) => {
      const l = raw.trim(), where = `index, line ${k + 1}`;
      if (!/^\d+$/.test(l)) errors.push(`${where} is "${l.slice(0, 20)}"; it must be the number ${k}.`);
      else if (+l !== k) errors.push(`${where} is ${l}; it must be ${k} (the index counts 0, 1, 2 … in order).`);
    });
    if (plines.length && xlines.length && plines.length !== xlines.length)
      errors.push(`The patterns file has ${plines.length} line${plines.length === 1 ? "" : "s"} but the index file has ${xlines.length}. They need one line each per pattern.`);

    if (errors.length) return { errors };

    // repeats inside the upload, and patterns already in the data set
    const bitsList = codes.map(c => [...c].map(Number));
    const firstSeen = new Map();
    codes.forEach((c, k) => {
      if (firstSeen.has(c)) warnings.push(`Pattern ${k} is the same as pattern ${firstSeen.get(c)}; it will be tested twice but added to the data set once.`);
      else firstSeen.set(c, k);
    });
    let known = 0;
    try {
      if (!baseKeys) {
        const r = await fetch(DATA + "keys.txt");
        if (r.ok) baseKeys = new Set((await r.text()).split(/\s+/).filter(Boolean));
      }
      if (baseKeys) known = bitsList.filter(b => baseKeys.has(keyOf(b))).length;
    } catch (e) { /* the check still works without it */ }
    const island = bitsList.filter(b => window.RigIsland.classify(b) === true).length;
    return { errors: [], warnings, codes, bitsList, island, known, extra: entries.length - 2 };
  }

  function showCheck(file, res) {
    const box = document.getElementById("check");
    box.hidden = false; box.innerHTML = "";
    const h = document.createElement("p"); h.className = "check-title";
    const p = (t, cls) => { const e = document.createElement("p"); if (cls) e.className = cls; e.textContent = t; box.appendChild(e); return e; };
    if (res.errors.length) {
      box.dataset.state = "bad";
      h.textContent = `${file.name}: the files need fixing`;
      box.appendChild(h);
      const ul = document.createElement("ul"); ul.className = "check-list";
      res.errors.slice(0, MAX_SHOWN_ERRORS).forEach(e => { const li = document.createElement("li"); li.textContent = e; ul.appendChild(li); });
      if (res.errors.length > MAX_SHOWN_ERRORS) { const li = document.createElement("li"); li.textContent = `… and ${res.errors.length - MAX_SHOWN_ERRORS} more problems.`; ul.appendChild(li); }
      box.appendChild(ul);
      p("Fix these and upload the zip again. Nothing has been submitted.", "fineprint");
      return;
    }
    const n = res.codes.length;
    box.dataset.state = "ok";
    h.textContent = `Correct files: you are testing ${n} pattern${n === 1 ? "" : "s"}`;
    box.appendChild(h);
    const facts = document.createElement("ul"); facts.className = "check-facts";
    const fact = t => { const li = document.createElement("li"); li.textContent = t; facts.appendChild(li); };
    fact(`${res.island} follow${res.island === 1 ? "s" : ""} the island algorithm, ${n - res.island} do${n - res.island === 1 ? "es" : ""} not.`);
    if (res.known) fact(`${res.known} ${res.known === 1 ? "is" : "are"} already in the data set: tested again, but not added a second time.`);
    if (res.extra > 0) fact(`${res.extra} other file${res.extra === 1 ? " in the zip was" : "s in the zip were"} ignored.`);
    box.appendChild(facts);
    if (res.warnings.length) {
      const ul = document.createElement("ul"); ul.className = "check-list warn";
      res.warnings.slice(0, MAX_SHOWN_ERRORS).forEach(e => { const li = document.createElement("li"); li.textContent = e; ul.appendChild(li); });
      box.appendChild(ul);
    }
    const grid = document.createElement("div"); grid.className = "check-grid";
    res.bitsList.forEach((b, k) => {
      const f = document.createElement("figure");
      f.appendChild(thumb(b));
      const c = document.createElement("figcaption"); c.textContent = k; f.appendChild(c);
      grid.appendChild(f);
    });
    box.appendChild(grid);
    const a = document.createElement("a"); a.className = "submit"; a.target = "_blank"; a.rel = "noopener";
    a.textContent = `Submit ${n} pattern${n === 1 ? "" : "s"} to the queue`;
    const title = encodeURIComponent(`Batch request: ${n} pattern${n === 1 ? "" : "s"}`);
    a.href = `https://github.com/${CFG.owner}/${CFG.repo}/issues/new?template=batch.yml&title=${title}&patterns=` +
      encodeURIComponent(res.bitsList.map(keyOf).join("\n"));
    box.appendChild(a);
    p("Submitting opens one pre-filled request on GitHub (free account needed). The patterns are written there in a short form; the bot lists them in full. They run one after another in index order.", "fineprint");
  }

  function setupBatch() {
    const input = document.getElementById("zip-input"), drop = document.getElementById("drop");
    const handle = async file => {
      if (!file) return;
      const box = document.getElementById("check");
      box.hidden = false; box.dataset.state = "busy"; box.textContent = `Checking ${file.name} …`;
      showCheck(file, await checkZip(file));
    };
    input.addEventListener("change", () => { handle(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => handle(e.dataTransfer.files[0]));
  }

  // batch requests in the queue: count the pattern lines of the Patterns field
  function batchSize(body) {
    const sec = (body || "").split(/^###\s+/m).find(x => /^patterns/i.test(x));
    if (!sec) return null;
    return sec.replace(/^.*\n/, "").split(/\r?\n/).map(l => l.trim())
      .filter(l => /^[01]{105}$/.test(l) || /^[0-9a-fA-F]{27}$/.test(l)).length;
  }

  function showBatchResult(box, i, b) {
    const tested = (b.patterns || []).filter(r => r.force_N && r.max_displacement_mm);
    if (!tested.length) return;
    const W = 260, H = 160, L = 30, B = 26, T = 8, R = 8;
    const xmax = Math.max(5, Math.ceil(Math.max(...tested.map(r => r.max_displacement_mm)) / 5) * 5), ymax = 20;
    const X = v => L + (W - L - R) * v / xmax, Y = v => H - B - (H - B - T) * v / ymax;
    const s = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `Force against displacement for the ${tested.length} patterns of batch ${i.number}` });
    [0, 10, 20].forEach(v => {
      el("line", { class: v ? "grid" : "axis", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, s);
      el("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, s).textContent = v;
    });
    for (let v = 0; v <= xmax; v += xmax > 20 ? 10 : 5)
      el("text", { x: X(v), y: H - B + 15, "text-anchor": "middle" }, s).textContent = v;
    el("text", { x: W - R, y: H - 1, "text-anchor": "end" }, s).textContent = "displacement (mm)";
    el("text", { x: L + 4, y: T + 2, "text-anchor": "start" }, s).textContent = "force (N)";
    tested.forEach(r => {
      const f = r.force_N, n = f.length;
      el("path", { class: "line thin", d: f.map((v, k) => (k ? "L" : "M") + X(r.max_displacement_mm * k / (n - 1)).toFixed(1) + " " + Y(v).toFixed(1)).join("") }, s);
    });
    const fig = document.createElement("figure"); fig.className = "result";
    const cap = document.createElement("figcaption");
    const a = document.createElement("a"); a.href = i.html_url; a.textContent = `#${i.number}`; cap.appendChild(a);
    const sp = document.createElement("span");
    sp.textContent = `batch of ${b.total}, ${tested.length} tested, ${ago(i.closed_at || i.updated_at)}`;
    cap.appendChild(sp);
    fig.appendChild(cap); fig.appendChild(s);
    box.appendChild(fig);
  }

  // ---------------------------------------------------------------- demo data
  function demoAdditions() {
    const now = Date.now();
    return Array.from({ length: 7 }, (_, k) => ({ issue: 30 + k, tested_at: new Date(now - k * 7200000).toISOString(),
      max: 25, bits: demoPattern(30 + k), data: [], island: k % 3 !== 1 }));
  }
  function demoPattern(seed) { let x = seed * 9301 + 49297; return Array.from({ length: N_CELLS }, () => ((x = (x * 9301 + 49297) % 233280) / 233280 < .5 ? 1 : 0)); }
  function demoBody(seed) { return "### Pattern (105 digits, 1 = insert)\n\n" + demoPattern(seed).join(""); }
  function demoCurve(n) {
    const s20 = 16 + (n % 7) * 2.2, d = [], f = [];
    for (let k = 0; k < 200; k++) {
      const x = k / 199, u = x * s20;
      d.push(u);
      f.push(20 * (0.62 * Math.tanh(2.6 * x) + 0.38 * Math.pow(x, 4)) / (0.62 * Math.tanh(2.6) + 0.38) - (x > .55 && x < .62 ? 1.3 * Math.sin((x - .55) / .07 * Math.PI) : 0));
    }
    return { issue: n, max_displacement_mm: s20, displacement_mm: d, force_N: f, frames: 12, pattern: demoPattern(n).join("") };
  }
  function demoIssues() {
    const now = Date.now(), t = m => new Date(now - m * 60000).toISOString();
    const user = l => ({ login: l });
    return {
      open: [
        { number: 1, labels: [{ name: "machine-status" }], body: '```json\n' + JSON.stringify({ state: "busy", job: 41, minutes_per_test: 9, updated: t(1),
          pattern: demoPattern(41).join(""), last: { issue: 39, batch_index: null, curve: "demo", frames: "demo", pattern: demoPattern(39).join("") } }) + '\n```', updated_at: t(1) },
        { number: 41, labels: [{ name: "running" }], body: demoBody(41), created_at: t(55), user: user("mkowalski"), html_url: "#" },
        { number: 43, labels: [{ name: "queued" }], body: demoBody(43), created_at: t(38), user: user("lhuang-mech"), html_url: "#" },
        { number: 44, labels: [{ name: "queued" }], body: demoBody(44), created_at: t(21), user: user("a-rossi"), html_url: "#" },
        { number: 46, labels: [{ name: "queued" }], body: demoBody(46), created_at: t(4), user: user("nsingh"), html_url: "#" }
      ],
      done: [37, 38, 39].map(n => ({ number: n, labels: [{ name: "done" }], body: demoBody(n), closed_at: t(60 * (40 - n)), html_url: "#" }))
    };
  }

  // ---------------------------------------------------------------- refresh loop
  let refreshCount = 0;
  async function refresh() {
    if (refreshCount % 5 === 0 && PAGE.dataset)
      loadDataset().then(showDataset).catch(() => { if (base) showDataset(); });
    try {
      const open = DEMO ? demoIssues().open : (await gh("/issues?state=open&per_page=100")).filter(i => !i.pull_request);
      showQueue(showStatus(open));
      if (refreshCount % 5 === 0 && PAGE.results) {
        const done = DEMO ? demoIssues().done : (await gh("/issues?state=closed&labels=done&sort=updated&direction=desc&per_page=6")).filter(i => !i.pull_request);
        showResults(done);
      }
    } catch (e) {
      queueMessage("The queue could not be loaded right now. The page tries again automatically.");
      if ($id("queue-sum")) $id("queue-sum").textContent = "";
      const res = $id("results");
      if (res && /Loading/.test(res.textContent)) res.innerHTML = '<p class="empty-note">Results could not be loaded right now. The page tries again automatically.</p>';
      if (e.message === "rate") setStatus("unknown", "Status paused for this browser", `GitHub limits how often one browser can check. Updates resume ${e.when ? "at " + e.when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "in a few minutes"}.`);
      else if (e.message === "missing") setStatus("unknown", "Not set up yet", `The page can't find the repository ${CFG.owner}/${CFG.repo}. Check owner and repo in assets/config.js.`);
      else setStatus("unknown", "Status unavailable", "The page could not reach GitHub. Check your connection; the page retries automatically.");
    }
    refreshCount++;
  }

  // ---------------------------------------------------------------- static parts
  function setupStatic() {
    const lab = CFG.labName || "";
    ["lab-name", "lab-name-foot"].forEach(id => { if ($id(id)) $id(id).textContent = lab; });
    const repoUrl = `https://github.com/${CFG.owner}/${CFG.repo}`;
    if ($id("repo-link")) $id("repo-link").href = repoUrl;
    if ($id("results-folder")) $id("results-folder").href = `${repoUrl}/tree/${CFG.branch || "main"}/results`;
    const live = $id("live");
    if (!live) { /* not on this page */ }
    else if (CFG.youtubeChannelId) {
      live.classList.add("on");
      live.innerHTML = `<iframe title="Live camera on the test rig" src="https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(CFG.youtubeChannelId)}&autoplay=1&mute=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    } else {
      live.innerHTML = "<p>The camera stream is not set up yet. When it is, you can watch the robot build and test each pattern here.</p>";
    }
    if (CFG.datasetDoi && document.querySelector(".ds-get")) {           // archived release (e.g. Zenodo), shown under the download button
      const p = document.createElement("p"); p.className = "fineprint";
      p.innerHTML = `Archived release: DOI <a href="https://doi.org/${encodeURI(CFG.datasetDoi)}">${CFG.datasetDoi}</a>`;
      document.querySelector(".ds-get").appendChild(p);
    }
  }

  // shared with extras.js (challenge, explorer, replay, rig-now panel)
  window.Rig = {
    CFG, RAW, DEMO, N_CELLS, codeIndex, el, thumb, drawLattice, ago, hasLabel, keyOf, demoPattern, demoCurve, fmt,
    getPattern: () => bits.slice(),
    loadPattern(arr) { bits = arr.slice(); if (PAGE.editor) render(); },
    setChallenge(target, method) { challenge.target = target || null; challenge.method = method || ""; if (PAGE.editor) render(); }
  };

  window.Rig.pageUrl = pageUrl;
  window.Rig.PAGE = PAGE;
  setupStatic();
  if (PAGE.editor) setupEditor();
  if (PAGE.batch) setupBatch();
  // first refresh once every script on the page (extras.js) has loaded
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh); else setTimeout(refresh, 0);
  setInterval(refresh, (CFG.refreshSeconds || 90) * 1000);
})();
