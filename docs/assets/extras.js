/* Metamaterial test rig: rig-now panel, test replay, inverse-design challenge + leaderboard,
   and the data-set explorer. Uses helpers shared by app.js (window.Rig). */
(function () {
  "use strict";
  const R = window.Rig;
  if (!R) return;
  const { CFG, RAW, DEMO, el } = R;
  const FLIM = 20;
  const $ = id => document.getElementById(id);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const bitsOf = code => [...code].map(Number);
  const fromData = (dd, max) => ({ x: dd.map((_, k) => max * k / (dd.length - 1)), y: dd.map(v => (v + 1) * FLIM / 2) });
  const fromCurve = c => ({ x: c.displacement_mm, y: c.force_N });
  async function getJSON(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(r.status); return r.json(); }

  // ---------------------------------------------------------------- force chart (SVG)
  // series: [{x:[], y:[], cls}] ; returns { svg, mark(x, y), unmark(), xmax, X, Y }
  function forceChart(series, opts = {}) {
    const W = opts.w || 320, H = opts.h || 200, L = 32, B = 28, T = 10, Rr = 10;
    const allx = series.flatMap(s => s.x);
    const xmax = opts.xmax || Math.max(5, Math.ceil(Math.max(...allx, 1) / 5) * 5), ymax = FLIM;
    const X = v => L + (W - L - Rr) * v / xmax, Y = v => H - B - (H - B - T) * Math.max(-1, v) / ymax;
    const s = el("svg", { class: "chart fchart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "Force against displacement" });
    [0, 5, 10, 15, 20].forEach(v => {
      el("line", { class: v ? "grid" : "axis", x1: L, x2: W - Rr, y1: Y(v), y2: Y(v) }, s);
      if (v % 10 === 0) el("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, s).textContent = v;
    });
    const step = xmax > 30 ? 10 : 5;
    for (let v = 0; v <= xmax; v += step) el("text", { x: X(v), y: H - B + 15, "text-anchor": "middle" }, s).textContent = v;
    el("text", { x: W - Rr, y: H - 2, "text-anchor": "end" }, s).textContent = "displacement (mm)";
    el("text", { x: L + 4, y: T + 2, "text-anchor": "start" }, s).textContent = "force (N)";
    series.forEach(sr => el("path", { class: "line " + (sr.cls || ""), d: sr.x.map((v, k) => (k ? "L" : "M") + X(v).toFixed(1) + " " + Y(sr.y[k]).toFixed(1)).join("") }, s));
    const dot = el("circle", { class: "mark", r: 5, visibility: "hidden" }, s);
    const vline = el("line", { class: "mark-line", y1: T, y2: H - B, visibility: "hidden" }, s);
    return {
      svg: s, xmax, X, Y, W, L, Rr,
      mark(x, y) { [dot, vline].forEach(e => e.setAttribute("visibility", "visible")); dot.setAttribute("cx", X(x)); dot.setAttribute("cy", Y(y)); vline.setAttribute("x1", X(x)); vline.setAttribute("x2", X(x)); },
      unmark() { [dot, vline].forEach(e => e.setAttribute("visibility", "hidden")); }
    };
  }

  // ---------------------------------------------------------------- replay: photos synced with the curve
  // frames.json: [{file, displacement_mm, force_N}] written by lab/agent.py next to curve.json
  const dialog = $("replay");
  let playTimer = null;
  function demoFrames(curve) {
    const n = 12, max = curve.max_displacement_mm;
    return Array.from({ length: n }, (_, k) => {
      const u = max * k / (n - 1), j = Math.round(k / (n - 1) * (curve.displacement_mm.length - 1));
      return { file: null, displacement_mm: u, force_N: curve.force_N[j], squash: 1 - 0.55 * u / 40 };
    });
  }
  async function openReplay({ title, curve, base, pattern }) {
    const body = $("replay-body");
    $("replay-title").textContent = `Replay: ${title}`;
    body.innerHTML = '<p class="empty-note">Loading the photos…</p>';
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    let frames;
    try { frames = DEMO ? demoFrames(curve) : await getJSON(base + "frames.json"); }
    catch (e) { body.innerHTML = '<p class="empty-note">No photos were published for this test.</p>'; return; }
    if (!frames.length) { body.innerHTML = '<p class="empty-note">No photos were published for this test.</p>'; return; }
    body.innerHTML = "";
    const stage = h("div", "replay-stage");
    const pic = h("div", "replay-pic");
    const ch = forceChart([fromCurve(curve)], { w: 380, h: 240, label: "Force against displacement; the marker shows where the photo was taken" });
    stage.append(pic, h("div", "replay-chart"));
    stage.lastChild.appendChild(ch.svg);
    const ctl = h("div", "replay-ctl");
    const play = h("button", "replay-play", "Play"); play.type = "button";
    const slider = document.createElement("input");
    Object.assign(slider, { type: "range", min: 0, max: frames.length - 1, value: 0, step: 1 });
    slider.setAttribute("aria-label", "Photo");
    const info = h("span", "replay-info");
    ctl.append(play, slider, info);
    body.append(stage, ctl, h("p", "fineprint", "Drag the slider or move along the curve to see the specimen at that point of the test. The photos are taken by the rig during compression."));
    const imgs = frames.map(f => {
      if (f.file) { const im = new Image(); im.src = base + f.file; im.alt = ""; return im; }
      const t = R.thumb(pattern ? bitsOf(pattern) : (curve.pattern ? bitsOf(curve.pattern) : R.demoPattern(1)), "replay-demo");
      t.style.transform = `scaleY(${f.squash})`; return t;
    });
    function show(k) {
      k = Math.max(0, Math.min(frames.length - 1, k));
      slider.value = k;
      pic.replaceChildren(imgs[k]);
      const f = frames[k];
      ch.mark(f.displacement_mm, f.force_N);
      info.textContent = `Photo ${k + 1} of ${frames.length} · ${f.displacement_mm.toFixed(1)} mm · ${f.force_N.toFixed(1)} N`;
    }
    const stop = () => { clearInterval(playTimer); playTimer = null; play.textContent = "Play"; };
    play.onclick = () => {
      if (playTimer) return stop();
      if (+slider.value >= frames.length - 1) show(0);
      play.textContent = "Pause";
      playTimer = setInterval(() => { const k = +slider.value + 1; if (k >= frames.length) stop(); else show(k); }, 450);
    };
    slider.oninput = () => { stop(); show(+slider.value); };
    ch.svg.addEventListener("pointermove", e => {
      const box = ch.svg.getBoundingClientRect();
      const x = ((e.clientX - box.left) * ch.W / box.width - ch.L) / (ch.W - ch.L - ch.Rr) * ch.xmax;
      let best = 0;
      frames.forEach((f, k) => { if (Math.abs(f.displacement_mm - x) < Math.abs(frames[best].displacement_mm - x)) best = k; });
      stop(); show(best);
    });
    show(0);
  }
  $("replay-close").onclick = () => { clearInterval(playTimer); playTimer = null; dialog.close ? dialog.close() : dialog.removeAttribute("open"); };
  dialog.addEventListener("close", () => { clearInterval(playTimer); playTimer = null; });
  dialog.addEventListener("click", e => { if (e.target === dialog) $("replay-close").click(); });

  // ---------------------------------------------------------------- rig-now panel
  let nowKey = null;
  async function onStatus(s, stale) {
    const label = $("now-label"), pat = $("now-pattern"), cur = $("now-curve"), note = $("now-note");
    const busy = s && !stale && s.state === "busy" && s.pattern;
    const last = s && s.last;
    const key = JSON.stringify(busy ? ["busy", s.job, s.batch_index, s.pattern] : ["last", last]);
    if (key === nowKey) return;
    nowKey = key;
    if (busy) {
      label.textContent = s.batch_index != null ? `Testing now: batch #${s.job}, pattern ${s.batch_index + 1}${s.batch_total ? " of " + s.batch_total : ""}` : `Testing now: request #${s.job}`;
      pat.replaceChildren(R.thumb(bitsOf(s.pattern), "now-thumb"));
      cur.innerHTML = '<p class="empty-note measuring">Measuring… The force curve appears here when this test is finished.</p>';
      note.textContent = `${s.pattern.split("").filter(b => b === "1").length} inserts. Watch it on the live view.`;
      return;
    }
    if (!last || !last.pattern) {
      label.textContent = "On the rig";
      pat.replaceChildren(); cur.innerHTML = '<p class="empty-note">Nothing tested from the queue yet.</p>'; note.textContent = "";
      return;
    }
    label.textContent = last.batch_index != null ? `Last test: batch #${last.issue}, pattern ${last.batch_index + 1}` : `Last test: request #${last.issue}`;
    pat.replaceChildren(R.thumb(bitsOf(last.pattern), "now-thumb"));
    cur.innerHTML = '<p class="empty-note">Loading the curve…</p>';
    try {
      const curve = DEMO ? R.demoCurve(last.issue) : await getJSON(`${RAW}/${last.curve}`);
      const ch = forceChart([fromCurve(curve)], { w: 300, h: 180 });
      cur.replaceChildren(ch.svg);
      note.textContent = `20 N reached at ${curve.max_displacement_mm.toFixed(1)} mm.`;
      if (last.frames) {
        const b = h("button", "replay-btn", "Replay the test"); b.type = "button";
        const base = DEMO ? "" : `${RAW}/${last.frames.replace(/frames\.json$/, "")}`;
        b.onclick = () => openReplay({ title: `request #${last.issue}${last.batch_index != null ? ", pattern " + (last.batch_index + 1) : ""}`, curve, base, pattern: last.pattern });
        note.appendChild(document.createTextNode(" ")); note.appendChild(b);
      }
    } catch (e) { cur.innerHTML = '<p class="empty-note">The curve is not available yet.</p>'; }
  }

  // ---------------------------------------------------------------- challenge + leaderboard
  let targets = [], board = [], selected = null;
  const entryCurves = new Map();
  function demoBoard() {
    const users = ["lhuang-mech", "a-rossi", "nsingh", "mkowalski", "j-okafor"];
    const methods = ["Nearest neighbour in the published curves, then greedy single-cell flips scored with a CNN forward model trained on the data set.",
      "Reservoir-computing estimate of inserts, islands and largest island, then island-algorithm synthesis.",
      "Graph neural network forward model + genetic algorithm (population 200, 40 generations).",
      "By hand: matched the stiffness first, then placed two weak rows to get the buckling events.",
      "Bayesian optimisation over a 12-dimensional island descriptor space."];
    return targets.flatMap((t, ti) => users.slice(0, 2 + (ti % 4)).map((u, k) => ({
      issue: 100 + ti * 10 + k, user: u, target: t.id, score_N: +(0.35 + ((ti * 7 + k * 13) % 17) / 20).toFixed(3),
      stroke_error_mm: +((((ti + k) % 5) - 2) * 0.7).toFixed(2), method: methods[(ti + k) % methods.length],
      tested_at: new Date(Date.now() - (ti * 5 + k) * 3600e3).toISOString(), pattern: R.demoPattern(ti * 10 + k).join("")
    })));
  }
  async function setupChallenge() {
    try { targets = (await getJSON("data/challenge.json")).targets; }
    catch (e) { $("target-view").innerHTML = '<p class="empty-note">The challenge targets could not be loaded.</p>'; return; }
    try { board = DEMO ? demoBoard() : await getJSON(`${RAW}/results/leaderboard.json`); } catch (e) { board = []; }
    drawTargets();
    selectTarget(targets[0].id);
  }
  const ranked = id => board.filter(e => e.target === id).sort((a, b) => a.score_N - b.score_N);
  function drawTargets() {
    const box = $("targets"); box.innerHTML = "";
    targets.forEach(t => {
      const b = h("button", "target-btn"); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.id = t.id;
      const c = fromData(t.dataData, t.max_displacement_mm);
      const spark = forceChart([{ ...c, cls: "target" }], { w: 150, h: 70, xmax: 40, label: `Target ${t.id}` });
      spark.svg.classList.add("spark");
      const best = ranked(t.id)[0];
      b.append(h("span", "t-id", t.id), spark.svg,
        h("span", "t-sub", `20 N at ${t.max_displacement_mm.toFixed(1)} mm · ${t.buckling_events} bucklings`),
        h("span", "t-best", best ? `Best ${best.score_N.toFixed(3)} N` : "No entries yet"));
      b.onclick = () => selectTarget(t.id);
      box.appendChild(b);
    });
  }
  async function curveOfEntry(e) {
    if (entryCurves.has(e.issue)) return entryCurves.get(e.issue);
    const c = DEMO ? (() => { const t = targets.find(x => x.id === e.target); const d = t.dataData.map((v, k) => Math.min(1, v + Math.sin(k / 15 + e.issue) * e.score_N / 20)); return fromData(d, t.max_displacement_mm + e.stroke_error_mm); })()
      : fromCurve(await getJSON(`${RAW}/results/${e.issue}/curve.json`));
    entryCurves.set(e.issue, c); return c;
  }
  async function selectTarget(id, entry) {
    selected = id;
    document.querySelectorAll(".target-btn").forEach(b => b.setAttribute("aria-selected", b.dataset.id === id ? "true" : "false"));
    const t = targets.find(x => x.id === id), list = ranked(id);
    const view = $("target-view"); view.innerHTML = "";
    const left = h("div", "tv-chart"), right = h("div", "tv-side");
    view.append(left, right);
    const series = [{ ...fromData(t.dataData, t.max_displacement_mm), cls: "target" }];
    const shown = entry || list[0];
    if (shown) { try { series.push({ ...(await curveOfEntry(shown)), cls: "entry" }); } catch (e) { /* not published */ } }
    const xmax = Math.max(5, Math.ceil(Math.max(...series.flatMap(s => s.x)) / 5) * 5);
    left.append(forceChart(series, { w: 460, h: 280, xmax, label: `Target ${id}${shown ? " and entry #" + shown.issue : ""}` }).svg);
    const legend = h("p", "tv-legend");
    legend.innerHTML = `<span class="lg target"></span>Target ${id}` + (shown && series.length > 1 ? ` <span class="lg entry"></span>Entry #${shown.issue} by ${shown.user} (${shown.score_N.toFixed(3)} N)` : "");
    left.appendChild(legend);

    right.append(h("h3", null, `Target ${id}`),
      h("p", null, `Displacement at 20 N: ${t.max_displacement_mm.toFixed(1)} mm. Buckling events: ${t.buckling_events}. ${list.length} entr${list.length === 1 ? "y" : "ies"} so far.`));
    const go = h("button", "submit", `Design a pattern for ${id}`); go.type = "button";
    go.onclick = () => { R.setChallenge(id, ""); drawBanner(); document.getElementById("single").scrollIntoView({ behavior: "smooth" }); };
    right.append(go, h("p", "fineprint", "Opens the editor in challenge mode. When you submit, you describe your method in the GitHub form; it is shown on the leaderboard."));

    const wrap = h("div", "lb-wrap");
    if (!list.length) wrap.append(h("p", "empty-note", "No entries for this target yet. Be the first."));
    else {
      const tb = h("table", "lb");
      tb.innerHTML = '<thead><tr><th scope="col">Rank</th><th scope="col">Entrant</th><th scope="col">Score (N)</th><th scope="col">Δ at 20 N</th><th scope="col">Method</th><th scope="col">Tested</th></tr></thead>';
      const body = document.createElement("tbody");
      list.forEach((e, k) => {
        const tr = document.createElement("tr");
        if (shown && e.issue === shown.issue) tr.className = "on";
        const td = (t, cls, label) => { const c = h("td", cls, t); c.dataset.label = label; tr.appendChild(c); return c; };
        td(String(k + 1), "lb-rank", "Rank");
        const who = td("", "lb-who", "Entrant");
        const a = h("a", null, e.user); a.href = `https://github.com/${CFG.owner}/${CFG.repo}/issues/${e.issue}`; who.append(a);
        td(e.score_N.toFixed(3), "lb-score", "Score (N)");
        td(`${e.stroke_error_mm > 0 ? "+" : ""}${e.stroke_error_mm.toFixed(1)} mm`, "lb-d", "Δ at 20 N");
        const m = td("", "lb-method", "Method");
        if ((e.method || "").length > 110) {
          const d = document.createElement("details"); d.append(h("summary", null, e.method.slice(0, 100).trim() + "…"), h("p", null, e.method)); m.append(d);
        } else m.textContent = e.method || "–";
        td(R.ago(e.tested_at), "lb-when", "Tested");
        const show = h("button", "lb-show", "Show curve"); show.type = "button";
        show.onclick = ev => { ev.stopPropagation(); selectTarget(id, e); };
        tr.lastChild.append(document.createElement("br"), show);
        body.appendChild(tr);
      });
      tb.appendChild(body); wrap.appendChild(tb);
    }
    view.appendChild(wrap);
  }
  function drawBanner() {
    const box = $("challenge-banner"), t = targets.find(x => x.id === challengeTarget());
    if (!t) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false; box.innerHTML = "";
    const c = forceChart([{ ...fromData(t.dataData, t.max_displacement_mm), cls: "target" }], { w: 220, h: 110, xmax: 40, label: `Target ${t.id}` });
    c.svg.classList.add("spark");
    const txt = h("div", "cb-text");
    txt.append(h("p", "cb-title", `Challenge mode: designing for target ${t.id}`),
      h("p", "fineprint", `Aim for 20 N at ${t.max_displacement_mm.toFixed(1)} mm with ${t.buckling_events} buckling events. The submit button below now sends your pattern to the challenge.`));
    const lab = h("label", "cb-label", "Your method (filled into the form; you can edit it there)");
    const ta = document.createElement("textarea"); ta.rows = 2; ta.maxLength = 1500; ta.id = "cb-method";
    ta.placeholder = "e.g. nearest neighbour in the data set, then single-cell flips";
    lab.htmlFor = "cb-method";
    ta.oninput = () => R.setChallenge(t.id, ta.value);
    const out = h("button", "cb-exit", "Leave challenge mode"); out.type = "button";
    out.onclick = () => { R.setChallenge(null); drawBanner(); };
    txt.append(lab, ta, out);
    box.append(c.svg, txt);
  }
  let _ct = null;
  const challengeTarget = () => _ct;
  const setCh = R.setChallenge;
  R.setChallenge = (t, m) => { _ct = t || null; setCh(t, m); };

  // ---------------------------------------------------------------- data-set explorer
  const AX = [
    { key: "disp", name: "Displacement at 20 N (mm)" }, { key: "inserts", name: "Inserts" }, { key: "islands", name: "Islands" },
    { key: "largest", name: "Largest island (cells)" }, { key: "events", name: "Buckling events" }];
  let X = null;   // loaded data
  async function loadExplorer() {
    const head = await getJSON("data/explorer.json");
    const buf = await (await fetch("data/explorer.bin")).arrayBuffer();
    const n = head.n;
    const P = new Uint8Array(buf, head.patterns.offset, head.patterns.bytes);
    const M = new Float32Array(buf.slice(head.max_displacement_mm.offset, head.max_displacement_mm.offset + head.max_displacement_mm.bytes));
    const C = new Uint8Array(buf, head.curves.offset, head.curves.bytes);
    const Mt = new Uint8Array(buf, head.metrics.offset, head.metrics.bytes);
    const col = k => Float32Array.from({ length: n }, (_, i) => Mt[i * 5 + k]);
    X = { n, P, M, C, pts: head.curve_points, v: { disp: M, inserts: col(0), islands: col(1), largest: col(2), events: col(3) }, isl: col(4) };
    buildExplorer();
  }
  const patternOf = i => Array.from({ length: R.N_CELLS }, (_, p) => (X.P[i * 14 + (p >> 3)] >> (7 - (p & 7))) & 1);
  const curveOf = i => {
    const y = Array.from({ length: X.pts }, (_, k) => X.C[i * X.pts + k] / 250 * 21 - 0.5);
    return { x: y.map((_, k) => X.M[i] * k / (X.pts - 1)), y };
  };
  function buildExplorer() {
    const app = $("explorer-app"); app.innerHTML = "";
    const ctl = h("div", "ex-ctl");
    const sel = (label, opts, val) => {
      const l = h("label", "ex-field"); l.append(h("span", null, label));
      const s = document.createElement("select"); opts.forEach(([v, t]) => { const o = new Option(t, v); s.add(o); }); s.value = val; l.append(s); ctl.append(l); return s;
    };
    const num = (label, val, step) => {
      const l = h("label", "ex-field ex-num"); l.append(h("span", null, label));
      const i = document.createElement("input"); i.type = "number"; i.step = step || 1; i.value = val; l.append(i); ctl.append(l); return i;
    };
    const ax = AX.map(a => [a.key, a.name]);
    const sx = sel("Horizontal axis", ax, "inserts"), sy = sel("Vertical axis", ax, "disp");
    const si = sel("Island algorithm", [["all", "All runs"], ["1", "Follows it"], ["0", "Does not"]], "all");
    const ev = sel("Buckling events", [["0", "Any"], ["1", "At least 1"], ["2", "At least 2"], ["3", "At least 3"]], "0");
    const nmin = num("Inserts from", 0), nmax = num("to", 105);
    const dmin = num("20 N from (mm)", 0, 0.5), dmax = num("to", 60, 0.5);
    const reset = h("button", "ex-reset", "Reset"); reset.type = "button"; ctl.append(reset);
    const count = h("p", "ex-count");
    const main = h("div", "ex-main");
    const plot = h("div", "ex-plot");
    const canvas = document.createElement("canvas"); canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Scatter plot of the measured runs. Click a point to see its pattern and curve.");
    const legend = h("p", "ex-legend"); legend.innerHTML = '<span class="lg isl"></span>Follows the island algorithm <span class="lg oth"></span>Does not';
    plot.append(canvas, legend);
    const detail = h("div", "ex-detail"); detail.append(h("p", "empty-note", "Click a point to see that run."));
    main.append(plot, detail);
    app.append(ctl, count, main);

    let vis = [], sxy = null, hover = -1, chosen = -1;
    const jit = i => (((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5;   // fixed jitter for whole-number axes
    function filter() {
      const isl = si.value, emin = +ev.value, a = +nmin.value, b = +nmax.value, c = +dmin.value, d = +dmax.value;
      vis = [];
      for (let i = 0; i < X.n; i++) {
        if (isl !== "all" && X.isl[i] !== +isl) continue;
        if (X.v.events[i] < emin || X.v.inserts[i] < a || X.v.inserts[i] > b || X.M[i] < c || X.M[i] > d) continue;
        vis.push(i);
      }
      count.textContent = `${R.fmt(vis.length)} of ${R.fmt(X.n)} runs match`;
      draw();
    }
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = plot.clientWidth || 600, H = Math.min(420, Math.max(280, W * 0.62));
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
      const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const L = 46, B = 38, T = 10, Rr = 12;
      const kx = sx.value, ky = sy.value, vx = X.v[kx], vy = X.v[ky];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < X.n; i++) { x0 = Math.min(x0, vx[i]); x1 = Math.max(x1, vx[i]); y0 = Math.min(y0, vy[i]); y1 = Math.max(y1, vy[i]); }
      const pad = (a, b) => [a - (b - a) * 0.04 - 0.5, b + (b - a) * 0.04 + 0.5];
      [x0, x1] = pad(x0, x1); [y0, y1] = pad(y0, y1);
      const intx = kx !== "disp", inty = ky !== "disp";
      const PX = (v, i) => L + (W - L - Rr) * ((v + (intx ? jit(i) * 0.7 : 0)) - x0) / (x1 - x0);
      const PY = (v, i) => H - B - (H - B - T) * ((v + (inty ? jit(i + 7) * 0.7 : 0)) - y0) / (y1 - y0);
      const css = getComputedStyle(document.documentElement);
      g.strokeStyle = css.getPropertyValue("--rule"); g.fillStyle = css.getPropertyValue("--ink-2"); g.font = "11px Archivo, system-ui, sans-serif"; g.lineWidth = 1;
      const ticks = (a, b) => { const span = b - a, st = span > 60 ? 20 : span > 25 ? 10 : span > 10 ? 5 : span > 5 ? 2 : 1; const out = []; for (let v = Math.ceil(a / st) * st; v <= b; v += st) out.push(v); return out; };
      g.textAlign = "right";
      ticks(y0, y1).forEach(v => { const y = PY(v, -7); g.beginPath(); g.moveTo(L, y); g.lineTo(W - Rr, y); g.globalAlpha = .5; g.stroke(); g.globalAlpha = 1; g.fillText(v, L - 6, y + 4); });
      g.textAlign = "center";
      ticks(x0, x1).forEach(v => g.fillText(v, PX(v, -7.5) - (intx ? 0 : 0), H - B + 16));
      g.fillText(AX.find(a => a.key === kx).name, (L + W - Rr) / 2, H - 6);
      g.save(); g.translate(12, (T + H - B) / 2); g.rotate(-Math.PI / 2); g.fillText(AX.find(a => a.key === ky).name, 0, 0); g.restore();
      const ci = css.getPropertyValue("--curve"), co = css.getPropertyValue("--insert-edge");
      sxy = new Float32Array(vis.length * 2);
      g.globalAlpha = vis.length > 4000 ? 0.35 : 0.6;
      vis.forEach((i, k) => {
        const x = PX(vx[i], i), y = PY(vy[i], i); sxy[2 * k] = x; sxy[2 * k + 1] = y;
        g.fillStyle = X.isl[i] ? ci : co; g.fillRect(x - 1.5, y - 1.5, 3, 3);
      });
      g.globalAlpha = 1;
      [hover, chosen].forEach((i, k) => {
        const j = vis.indexOf(i); if (j < 0) return;
        g.beginPath(); g.arc(sxy[2 * j], sxy[2 * j + 1], k ? 6 : 5, 0, 7); g.lineWidth = 2; g.strokeStyle = css.getPropertyValue("--ink"); g.stroke();
      });
    }
    function nearest(e) {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bd = 100;
      for (let k = 0; k < vis.length; k++) { const d = (sxy[2 * k] - x) ** 2 + (sxy[2 * k + 1] - y) ** 2; if (d < bd) { bd = d; best = vis[k]; } }
      return best;
    }
    canvas.addEventListener("pointermove", e => { const i = nearest(e); if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? "pointer" : "default"; draw(); } });
    canvas.addEventListener("pointerleave", () => { hover = -1; draw(); });
    canvas.addEventListener("click", e => { const i = nearest(e); if (i >= 0) { chosen = i; draw(); showRun(i); } });
    function showRun(i) {
      detail.innerHTML = "";
      const bits = patternOf(i);
      const top = h("div", "ex-run");
      top.append(R.thumb(bits, "ex-thumb"));
      const facts = h("dl", "ex-facts");
      [["Displacement at 20 N", `${X.M[i].toFixed(1)} mm`], ["Inserts", X.v.inserts[i]], ["Islands", X.v.islands[i]],
       ["Largest island", `${X.v.largest[i]} cells`], ["Buckling events", X.v.events[i]], ["Island algorithm", X.isl[i] ? "Follows it" : "Does not"]]
        .forEach(([k, v]) => { facts.append(h("dt", null, k), h("dd", null, String(v))); });
      top.append(facts);
      detail.append(h("h3", null, `Run ${R.fmt(i)}`), top, forceChart([curveOf(i)], { w: 320, h: 190 }).svg);
      const open = h("button", "submit", "Open this pattern in the editor"); open.type = "button";
      open.onclick = () => { R.loadPattern(bits); document.getElementById("single").scrollIntoView({ behavior: "smooth" }); };
      const copy = h("button", "ex-copy", "Copy the 105-digit code"); copy.type = "button";
      copy.onclick = async () => { try { await navigator.clipboard.writeText(bits.join("")); copy.textContent = "Copied"; } catch (e) { copy.textContent = bits.join(""); } };
      detail.append(open, copy, h("p", "fineprint", "Row number in the downloaded data set. The curve here is a 50-point preview; the download has all 200 points."));
    }
    [sx, sy, si, ev].forEach(s => s.addEventListener("change", filter));
    [nmin, nmax, dmin, dmax].forEach(s => s.addEventListener("input", filter));
    reset.onclick = () => { sx.value = "inserts"; sy.value = "disp"; si.value = "all"; ev.value = "0"; nmin.value = 0; nmax.value = 105; dmin.value = 0; dmax.value = 60; filter(); };
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 150); });
    filter();
  }
  function setupExplorer() {
    const start = () => loadExplorer().catch(() => { $("explorer-app").innerHTML = '<p class="empty-note">The explorer data could not be loaded.</p>'; });
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "800px" });
      io.observe($("explorer"));
    } else start();
  }

  window.RigExtras = { onStatus, openReplay, onPattern: null };
  setupChallenge();
  setupExplorer();
})();
