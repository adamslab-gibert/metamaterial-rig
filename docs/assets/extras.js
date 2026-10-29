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
    if (opts.normalised) {
      [0, 0.25, 0.5, 0.75, 1].forEach(v => el("text", { x: X(v), y: H - B + 15, "text-anchor": "middle" }, s).textContent = v);
      el("text", { x: W - Rr, y: H - 2, "text-anchor": "end" }, s).textContent = "fraction of the stroke to 20 N (0–1)";
    } else {
      const step = xmax > 30 ? 10 : 5;
      for (let v = 0; v <= xmax; v += step) el("text", { x: X(v), y: H - B + 15, "text-anchor": "middle" }, s).textContent = v;
      el("text", { x: W - Rr, y: H - 2, "text-anchor": "end" }, s).textContent = "displacement (mm)";
    }
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
    const ch = forceChart([fromCurve(curve)], { w: 380, h: 240, label: "Force against displacement. The marker shows where the photo was taken" });
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
  if (dialog) $("replay-close").onclick = () => { clearInterval(playTimer); playTimer = null; dialog.close ? dialog.close() : dialog.removeAttribute("open"); };
  if (dialog) {
    dialog.addEventListener("close", () => { clearInterval(playTimer); playTimer = null; });
    dialog.addEventListener("click", e => { if (e.target === dialog) $("replay-close").click(); });
  }

  // ---------------------------------------------------------------- rig-now panel
  let nowKey = null;
  async function onStatus(s, stale) {
    if (!$("now")) return;
    const label = $("now-label"), pat = $("now-pattern"), cur = $("now-curve"), note = $("now-note");
    const busy = s && !stale && s.state === "busy" && s.pattern;
    const last = s && s.last;
    const key = JSON.stringify(busy ? ["busy", s.job, s.batch_index, s.pattern] : ["last", last]);
    if (key === nowKey) return;
    nowKey = key;
    if (busy) {
      label.textContent = s.auto ? "Automatic data generation in progress" :
        s.batch_index != null ? `Testing now: batch #${s.job}, pattern ${s.batch_index + 1}${s.batch_total ? " of " + s.batch_total : ""}` : `Testing now: request #${s.job}`;
      pat.replaceChildren(R.thumb(bitsOf(s.pattern), "now-thumb"));
      cur.innerHTML = s.auto ? "" : '<p class="empty-note measuring">Measuring… The force curve appears here when this test is finished.</p>';
      note.textContent = s.auto ? "" : `${s.name ? "Submitted by " + s.name + ". " : ""}${s.pattern.split("").filter(b => b === "1").length} inserts. Watch it on the live view.`;
      return;
    }
    if (!last || !last.pattern) {
      label.textContent = "On the rig";
      pat.replaceChildren(); cur.innerHTML = '<p class="empty-note">Nothing tested from the queue yet.</p>'; note.textContent = "";
      return;
    }
    label.textContent = String(last.issue).startsWith("auto-") ? `Last test: automatic pattern ${String(last.issue).slice(5)}` :
      last.batch_index != null ? `Last test: batch #${last.issue}, pattern ${last.batch_index + 1}` : `Last test: request #${last.issue}`;
    if (last.name && !String(last.issue).startsWith("auto-")) label.textContent += ` by ${last.name}`;
    pat.replaceChildren(R.thumb(bitsOf(last.pattern), "now-thumb"));
    cur.innerHTML = '<p class="empty-note">Loading the curve…</p>';
    try {
      const curve = DEMO ? R.demoCurve(last.issue) : await getJSON(`${RAW}/${last.curve}`);
      const ch = forceChart([fromCurve(curve)], { w: 300, h: 180 });
      cur.replaceChildren(ch.svg);
      note.textContent = curve.status && curve.status !== "ok"
        ? `Stopped at the ${curve.max_displacement_mm.toFixed(1)} mm travel limit at ${(curve.max_force_N ?? Math.max(...curve.force_N)).toFixed(1)} N.`
        : `20 N reached at ${curve.max_displacement_mm.toFixed(1)} mm.`;
      if (last.frames) {
        const b = h("button", "replay-btn", "Replay the test"); b.type = "button";
        const base = DEMO ? "" : `${RAW}/${last.frames.replace(/frames\.json$/, "")}`;
        b.onclick = () => openReplay({ title: String(last.issue).startsWith("auto-") ? `automatic pattern ${String(last.issue).slice(5)}` : `request #${last.issue}${last.batch_index != null ? ", pattern " + (last.batch_index + 1) : ""}`, curve, base, pattern: last.pattern });
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
      issue: 100 + k, curve: "demo", user: u, target: t.id, score_N: +(0.35 + ((ti * 7 + k * 13) % 17) / 20).toFixed(3),
      stroke_error_mm: +((((ti + k) % 5) - 2) * 0.7).toFixed(2), method: methods[(ti + k) % methods.length],
      tested_at: new Date(Date.now() - (ti * 5 + k) * 3600e3).toISOString(), pattern: R.demoPattern(ti * 10 + k).join("")
    })));
  }
  async function setupChallenge() {
    try { targets = (await getJSON("data/challenge.json")).targets; }
    catch (e) { if ($("target-view")) $("target-view").innerHTML = '<p class="empty-note">The challenge targets could not be loaded.</p>'; return; }
    if ($("challenge-banner")) {                       // Submit page: challenge mode from ?challenge=T3
      const want = (new URLSearchParams(location.search).get("challenge") || "").toUpperCase();
      const tw = targets.find(t => t.id === want);
      if (tw) { R.setChallenge(want, "", tw.pattern); drawBanner(); }
    }
    if (!$("targets")) return;
    try { board = DEMO ? demoBoard() : await getJSON(`${RAW}/results/leaderboard.json`); } catch (e) { board = []; }
    drawTargets();
    drawBoard();
    selectTarget(targets[0].id);
  }
  // One leaderboard, one row per submission (request): a 10-target upload is one row with its own method and
  // its own average, so one person can compare different algorithms or trials. The overall score is the
  // average of the submission's best score on each of the ten targets; a submission is ranked once it has an
  // entry for every target, the others are listed below unranked. "Curve" is offered for the top 3 per target.
  function boardRows() {
    const top3 = {}; targets.forEach(t => { top3[t.id] = new Set(ranked(t.id).slice(0, 3).map(entryKey)); });
    const by = new Map();
    board.forEach(e => {
      const r = by.get(e.issue) || { issue: e.issue, user: e.user, name: e.name || e.user, best: {}, latest: e };
      if (!r.best[e.target] || e.score_N < r.best[e.target].score_N) r.best[e.target] = e;
      if (new Date(e.tested_at) >= new Date(r.latest.tested_at)) r.latest = e;
      by.set(e.issue, r);
    });
    const rows = [...by.values()];
    rows.forEach(r => {
      r.done = targets.filter(t => r.best[t.id]).length;
      r.complete = r.done === targets.length;
      r.overall = r.complete ? targets.reduce((a, t) => a + r.best[t.id].score_N, 0) / targets.length : null;
    });
    rows.sort((a, b) => (b.complete - a.complete) || (a.complete ? a.overall - b.overall : (b.done - a.done) || (new Date(b.latest.tested_at) - new Date(a.latest.tested_at))));
    return { rows, top3 };
  }
  const LB_SHOWN = 10;          // rows on the leaderboard: the best ranked submissions, then unranked ones if room is left
  function drawBoard(shown) {
    const wrap = $("lb-all"); if (!wrap) return;
    wrap.innerHTML = "";
    if (!board.length) { wrap.append(h("p", "empty-note", "No entries yet. Be the first.")); return; }
    const all = boardRows(), top3 = all.top3;
    const rankedRows = all.rows.filter(r => r.complete);
    const rows = all.rows.slice(0, LB_SHOWN);
    const tb = h("table", "lb lb-all");
    const head = document.createElement("thead"), hr = document.createElement("tr");
    [["Rank"], ["Entrant", "Overall score: the average over all ten targets"], ...targets.map(t => [t.id, `Best score for ${t.id}`]), ["Method"]]
      .forEach(([txt, title]) => { const th = h("th", null, txt); th.scope = "col"; if (title) th.title = title; hr.appendChild(th); });
    head.appendChild(hr); tb.appendChild(head);
    const body = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      if (!r.complete) tr.className = "partial";
      const td = (txt, cls, label) => { const c = h("td", cls, txt); c.dataset.label = label; tr.appendChild(c); return c; };
      td(r.complete ? String(rankedRows.indexOf(r) + 1) : "–", "lb-rank", "Rank");
      const who = td("", "lb-who", "Entrant");
      const a = h("a", null, r.name); a.title = `Request #${r.issue} (GitHub: ${r.user})`; a.href = `https://github.com/${CFG.owner}/${CFG.repo}/issues/${r.issue}`; a.target = "_blank"; a.rel = "noopener";
      who.append(a, h("span", "lb-req", `#${r.issue} · ${R.ago(r.latest.tested_at)}`), h("span", "lb-overall", r.complete ? `${r.overall.toFixed(3)} N` : `${r.done} of ${targets.length} targets`));
      targets.forEach(t => {
        const e = r.best[t.id];
        const c = td("", "lb-t", t.id);
        if (!e) { c.textContent = "–"; c.classList.add("none"); return; }
        if (shown && entryKey(e) === entryKey(shown)) c.classList.add("on");
        const place = ranked(t.id).findIndex(x => entryKey(x) === entryKey(e));     // rank of this entry on this target
        c.append(h("span", "lb-score", e.score_N.toFixed(3)));
        const ord = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
        c.append(h("span", "lb-medal" + (place < 3 ? "" : " plain"), ord(place + 1)));
        if (/^[01]{105}$/.test(e.pattern || "")) { const tb = t.pattern; c.append(h("span", "lb-miss", `${[...e.pattern].reduce((a, b, k) => a + (b !== tb[k] ? 1 : 0), 0)} cells off`)); }
        if (e.reached_20N === false) c.append(h("span", "lb-short", `only ${(e.max_force_N || 0).toFixed(1)} N`));
        if (e.curve) {
          const show = h("button", "lb-show", "Curve"); show.type = "button"; show.title = `Show this entry against target ${t.id}`;
          show.onclick = ev => { ev.stopPropagation(); selectTarget(t.id, e); $("challenge").scrollIntoView({ behavior: "smooth", block: "start" }); };
          c.append(show);
        }
      });
      const m = td("", "lb-method", "Method"), text = r.latest.method || "–";
      if (text.length > 110) {
        const d = document.createElement("details"); d.append(h("summary", null, text.slice(0, 100).trim() + "…"), h("p", null, text)); m.append(d);
      } else m.textContent = text;
      body.appendChild(tr);
    });
    tb.appendChild(body); wrap.appendChild(tb);
    wrap.append(h("p", "fineprint lb-note", "One row per submission, so you can compare your own methods or trials. Scores are the RMS difference to the target in newtons. The overall score is the average of the submission's score on each target, so a submission is ranked once it covers all ten targets. The ten best submissions are shown. An entry that did not reach 20 N is still scored over the stroke it reached, and is marked. Curves of entries outside the three best for a target are kept for six weeks."));
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
        h("span", "t-best", best ? `Best ${best.score_N.toFixed(3)} N` : "No entries yet"));
      b.onclick = () => selectTarget(t.id);
      box.appendChild(b);
    });
  }
  const entryKey = e => `${e.issue}-${e.batch_index == null ? "" : e.batch_index}`;
  async function curveOfEntry(e) {
    if (entryCurves.has(entryKey(e))) return entryCurves.get(entryKey(e));
    const c = DEMO ? (() => { const t = targets.find(x => x.id === e.target); const d = t.dataData.map((v, k) => Math.min(1, v + Math.sin(k / 15 + e.issue) * e.score_N / 20)); return fromData(d, t.max_displacement_mm + e.stroke_error_mm); })()
      : fromCurve(await getJSON(`${RAW}/${e.curve || `results/${e.issue}/curve.json`}`));
    entryCurves.set(entryKey(e), c); return c;
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
    if (shown && shown.curve) { try { series.push({ ...(await curveOfEntry(shown)), cls: "entry" }); } catch (e) { /* not published */ } }
    // two views: the normalised stroke (0–1), which is what the score compares, and the actual displacement in mm
    const comparing = series.length > 1;
    const xmax = Math.max(5, Math.ceil(Math.max(...series.flatMap(s => s.x)) / 5) * 5);
    const norm = series.map(sr => ({ ...sr, x: sr.x.map((_, k) => k / (sr.x.length - 1)) }));
    const chartBox = h("div", "tv-chartbox");
    const sw = h("div", "tv-switch"); sw.setAttribute("role", "tablist");
    const mk = (label, key) => { const b = h("button", "tv-view", label); b.type = "button"; b.dataset.view = key; b.setAttribute("role", "tab"); sw.appendChild(b); return b; };
    const bN = mk("Normalised stroke (0–1)", "norm"), bM = mk("Actual displacement (mm)", "mm");
    const note = h("p", "fineprint tv-note");
    const draw = view => {
      chartBox.innerHTML = "";
      [bN, bM].forEach(b => b.setAttribute("aria-selected", b.dataset.view === view ? "true" : "false"));
      chartBox.append(view === "norm"
        ? forceChart(norm, { w: 460, h: 280, xmax: 1, normalised: true, label: `Target ${id}${shown ? " and entry #" + shown.issue : ""}, normalised stroke` }).svg
        : forceChart(series, { w: 460, h: 280, xmax, label: `Target ${id}${shown ? " and entry #" + shown.issue : ""}` }).svg);
      note.textContent = view === "norm"
        ? "Both curves stretched to the same length, 0 to 1 of their own stroke to 20 N. The score is the RMS gap between the lines in this view."
        : "Each curve against the displacement the rig measured. The difference in where the curves end is the Δ at 20 N shown on the leaderboard.";
    };
    bN.onclick = () => draw("norm"); bM.onclick = () => draw("mm");
    left.append(sw, chartBox);
    draw(comparing ? "norm" : "mm");
    const legend = h("p", "tv-legend");
    legend.innerHTML = `<span class="lg target"></span>Target ${id}` + (shown && series.length > 1 ? ` <span class="lg entry"></span>Entry #${shown.issue} by ${shown.name || shown.user} (${shown.score_N.toFixed(3)} N${shown.reached_20N === false ? `, reached only ${(shown.max_force_N || 0).toFixed(1)} N` : ""})` : "");
    left.append(legend, note);

    right.append(h("h3", null, `Target ${id}`),
      h("p", null, `${list.length} entr${list.length === 1 ? "y" : "ies"} so far.`));
    const go = h("button", "submit", `Design a pattern for ${id}`); go.type = "button";
    go.onclick = () => { location.href = R.pageUrl("submit.html", { challenge: id }) + "#single"; };
    right.append(go, h("p", "fineprint", "Opens the editor on the Submit page in challenge mode. You describe your method there, and it is shown on the leaderboard."));
    // the target's pattern, and the shown entry's pattern with the cells that differ outlined
    const tb = [...t.pattern].map(Number);
    const comp = h("div", "tv-compare");
    const fig = (bits, caption, diff) => { const f = h("figure"); f.append(R.thumb(bits, "tv-thumb", diff), h("figcaption", null, caption)); return f; };
    comp.append(fig(tb, `Target ${id}`));
    if (shown && /^[01]{105}$/.test(shown.pattern || "")) {
      const eb = [...shown.pattern].map(Number), miss = eb.reduce((a, b, k) => a + (b !== tb[k] ? 1 : 0), 0);
      comp.append(fig(eb, `Entry #${shown.issue}`, tb));
      const note = h("p", "fineprint"); note.append(h("span", "tv-miss", `${miss} of 105 cells differ`), ` between the entry and the target (outlined in red). Different patterns can give very similar curves, which is what makes the problem interesting.`);
      const open = h("a", null, "Open this entry's pattern in the editor"); open.href = R.pageUrl("submit.html", { pattern: shown.pattern, challenge: id }) + "#single";
      const op = h("p", "fineprint"); op.append(open);
      right.append(comp, note, op);
    } else right.append(comp);
  }
  function drawBanner() {
    const box = $("challenge-banner"), t = targets.find(x => x.id === challengeTarget());
    if (!t) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false; box.innerHTML = "";
    const c = forceChart([{ ...fromData(t.dataData, t.max_displacement_mm), cls: "target" }], { w: 220, h: 110, xmax: 40, label: `Target ${t.id}` });
    c.svg.classList.add("spark");
    const txt = h("div", "cb-text");
    const back = h("a", null, "see the target and leaderboard"); back.href = R.pageUrl("challenge.html");
    txt.append(h("p", "cb-title", `Challenge mode: designing for target ${t.id}`),
      h("p", "fineprint", `The submit button below now sends your pattern to the challenge. `));
    txt.lastChild.append(back, ".");
    const lab = h("label", "cb-label", "Your method (filled into the form, where you can still edit it)");
    const ta = document.createElement("textarea"); ta.rows = 2; ta.maxLength = 1500; ta.id = "cb-method";
    ta.placeholder = "e.g. nearest neighbour in the data set, then single-cell flips";
    lab.htmlFor = "cb-method";
    ta.oninput = () => R.setChallenge(t.id, ta.value);
    const out = h("button", "cb-exit", "Leave challenge mode"); out.type = "button";
    out.onclick = () => { R.setChallenge(null); drawBanner(); history.replaceState(null, "", R.pageUrl("submit.html") + "#single"); };
    txt.append(lab, ta, out);
    box.append(c.svg, txt);
  }
  let _ct = null;
  const challengeTarget = () => _ct;
  const setCh = R.setChallenge;
  R.setChallenge = (t, m, pattern) => { _ct = t || null; const tp = pattern || (targets.find(x => x.id === t) || {}).pattern; setCh(t, m, tp); };

  // ---------------------------------------------------------------- challenge: download targets, upload entries
  const MAX_ENTRIES = 10;
  async function downloadTargets() {
    const btn = $("ch-download"), note = $("ch-download-note");
    if (!targets.length || !window.JSZip) { note.textContent = "The targets are not loaded yet. Please try again in a moment."; return; }
    btn.disabled = true; btn.textContent = "Preparing…";
    try {
      const n = targets.length, zip = new JSZip();
      zip.file("targets_dataData.npy", R.npyWrite("<f4", [n, 200], [R.npyEncode("<f4", targets.flatMap(t => t.dataData))]));
      zip.file("targets_maxData.npy", R.npyWrite("<f8", [n], [R.npyEncode("<f8", targets.map(t => t.max_displacement_mm))]));
      zip.file("targets.csv", "row,target\n" + targets.map((t, k) => `${k},${t.id}`).join("\n") + "\n");
      let long = "target,point,displacement_mm,force_N,dataData\n";
      targets.forEach(t => t.dataData.forEach((v, k) => {
        long += `${t.id},${k},${(t.max_displacement_mm * k / (t.dataData.length - 1)).toFixed(4)},${((v + 1) * FLIM / 2).toFixed(4)},${v}\n`;
      }));
      zip.file("targets_curves.csv", long);
      zip.file("targets_patterns.txt", targets.map(t => `${t.id} ${t.pattern}`).join("\n") + "\n");
      const site = `https://${CFG.owner}.github.io/${CFG.repo}/`;
      zip.file("README.txt", `INVERSE DESIGN CHALLENGE: TARGET CURVES
${"=".repeat(78)}
${CFG.labName || ""}, Purdue University. Downloaded ${new Date().toISOString().slice(0, 10)} from ${site}challenge.html

Ten force-displacement curves measured on the rig. Their patterns are published
(targets_patterns.txt) but are not in the data set. Find, for any target, a DIFFERENT
pattern of inserts whose measured curve matches it: an entry that is the target's own
pattern is refused. Many different patterns give near-identical curves, which is the
point of the problem.

FILES (row k of every file is target T(k+1))
targets_dataData.npy  shape (${n}, 200), float32
  Force at 200 equal steps of displacement from 0 to maxData, stored as
  dataData = 2 * F / 20 N - 1, so F [N] = (dataData + 1) * 10. Same as dataData.npy
  in the data set.
targets_maxData.npy   shape (${n},), float64
  Displacement at which the force reached 20 N [mm]. Point k is at maxData * k / 199.
targets.csv           which row of the .npy files is which target
targets_curves.csv    the same curves in long form: target, point, displacement [mm],
                      force [N], dataData
targets_patterns.txt  the pattern of each target: "T1 <105 digits>" (bottom row first,
                      1 = insert), one line per target

SCORE
  Root-mean-square (RMS) difference between the measured curve of your pattern and the
  target, in N: sqrt(mean(((dataData_yours - dataData_target) * 10)^2)). The difference
  in displacement at 20 N is reported alongside.

LEADERBOARD
  One row per entrant, with the best score for each target. The overall score is the
  average of the best scores over all ten targets, so an entrant is ranked once every
  target has an entry. The measured curve can be viewed for the three best entries of
  each target.

SUBMITTING
  In the editor: ${site}submit.html?challenge=T1 (one pattern).
  As a zip: ${site}challenge.html#upload with two text files
    patterns   one pattern per line: 105 digits of 0 and 1, bottom row first, 1 = insert
    targets    one target per line (T1 ... T10), same order as patterns
  At most one pattern per target per upload. You also describe your method.
  The pattern format is explained in the README of the data set download.

The published data set (${site}data.html) is the training data (CC BY 4.0). Please use the
standard split (${site}challenge.html#split): train.txt / validation.txt / test.txt.
`);
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "challenge_targets.zip";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      note.textContent = `Downloaded ${n} target curves.`;
    } catch (e) { note.textContent = "The download could not be prepared (" + e.message + ")."; }
    btn.disabled = false; btn.textContent = "Download the target curves (.zip)";
  }

  const linesOf = text => { const l = text.replace(/^﻿/, "").split(/\r?\n/); while (l.length && !l[l.length - 1].trim()) l.pop(); return l; };
  async function checkEntriesZip(file) {
    const errors = [];
    if (!window.JSZip) return { errors: ["The checker could not load. Reload the page and try again."] };
    let zip;
    try { zip = await JSZip.loadAsync(file); }
    catch (e) { return { errors: [`"${file.name}" could not be opened as a zip file.`] }; }
    const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
    const baseName = f => f.name.split("/").pop().replace(/\.(txt|csv|dat)$/i, "").toLowerCase();
    const found = entries.map(f => f.name.split("/").pop());
    const pick = want => {
      const m = entries.filter(f => baseName(f) === want);
      if (!m.length) { errors.push(`The zip has no file called "${want}". ` + (found.length ? `It contains: ${found.slice(0, 8).join(", ")}.` : "It is empty.")); return null; }
      if (m.length > 1) { errors.push(`The zip has ${m.length} files called "${want}". Keep only one.`); return null; }
      return m[0];
    };
    const pf = pick("patterns"), tf = pick("targets");
    if (!pf || !tf) return { errors };
    const pl = linesOf(await pf.async("string")), tl = linesOf(await tf.async("string"));
    const ids = targets.map(t => t.id), codes = [], tids = [];
    if (!pl.length) errors.push("The patterns file is empty.");
    pl.forEach((raw, k) => {
      const l = raw.replace(/[\s,]/g, ""), where = `patterns, line ${k + 1}`;
      if (!l) errors.push(`${where} is empty.`);
      else if (/[^01]/.test(l)) errors.push(`${where} contains characters other than 0 and 1.`);
      else if (l.length !== R.N_CELLS) errors.push(`${where} has ${l.length} digits. A pattern needs exactly ${R.N_CELLS}.`);
      codes.push(l);
    });
    const seen = new Map();
    tl.forEach((raw, k) => {
      const v = raw.trim().toUpperCase(), id = /^\d+$/.test(v) ? "T" + v : v, where = `targets, line ${k + 1}`;
      if (!ids.includes(id)) errors.push(`${where} is "${raw.trim().slice(0, 12)}"; it must be one of ${ids[0]} … ${ids[ids.length - 1]}.`);
      else if (seen.has(id)) errors.push(`${where}: ${id} is already on line ${seen.get(id) + 1}. Use at most one pattern per target.`);
      else seen.set(id, k);
      tids.push(id);
    });
    if (pl.length > MAX_ENTRIES) errors.push(`The patterns file has ${pl.length} lines. At most ${MAX_ENTRIES} are allowed (one per target).`);
    if (pl.length && tl.length && pl.length !== tl.length) errors.push(`The patterns file has ${pl.length} lines but the targets file has ${tl.length}. They need one line each per entry.`);
    if (errors.length) return { errors };
    codes.forEach((c, k) => { const t = targets.find(x => x.id === tids[k]); if (t && t.pattern === c) errors.push(`patterns, line ${k + 1} is target ${tids[k]}'s own pattern. The challenge is to find a different pattern with the same curve.`); });
    if (errors.length) return { errors };
    const bits = codes.map(c => [...c].map(Number));
    return { errors: [], items: bits.map((b, k) => ({ target: tids[k], bits: b, island: window.RigIsland.classify(b) === true })), extra: entries.length - 2 };
  }

  function showEntriesCheck(file, res) {
    const box = $("ch-check");
    box.hidden = false; box.innerHTML = "";
    const title = h("p", "check-title");
    box.appendChild(title);
    if (res.errors.length) {
      box.dataset.state = "bad";
      title.textContent = `${file.name}: the files need fixing`;
      const ul = h("ul", "check-list");
      res.errors.slice(0, 8).forEach(e => ul.appendChild(h("li", null, e)));
      if (res.errors.length > 8) ul.appendChild(h("li", null, `… and ${res.errors.length - 8} more problems.`));
      box.append(ul, h("p", "fineprint", "Fix these and upload the zip again. Nothing has been submitted."));
      return;
    }
    const n = res.items.length;
    box.dataset.state = "ok";
    title.textContent = `Correct files: ${n} entr${n === 1 ? "y" : "ies"} for ${res.items.map(i => i.target).join(", ")}`;
    if (res.extra > 0) box.appendChild(h("p", "fineprint", `${res.extra} other file${res.extra === 1 ? " in the zip was" : "s in the zip were"} ignored.`));
    const grid = h("div", "ch-entries");
    res.items.forEach(it => {
      const t = targets.find(x => x.id === it.target);
      const card = h("figure", "ch-entry");
      const spark = forceChart([{ ...fromData(t.dataData, t.max_displacement_mm), cls: "target" }], { w: 150, h: 70, xmax: 40, label: `Target ${t.id}` });
      spark.svg.classList.add("spark");
      const cap = h("figcaption", null);
      cap.append(h("strong", null, it.target), h("span", null, `${it.bits.reduce((a, b) => a + b, 0)} inserts · ${it.island ? "island algorithm" : "not island"}`));
      card.append(R.thumb(it.bits, "ch-thumb"), spark.svg, cap);
      grid.appendChild(card);
    });
    box.appendChild(grid);
    const method = $("ch-method").value.trim();
    const sub = h("a", "submit");
    const update = () => {
      const m = $("ch-method").value.trim(), who = R.yourName();
      const okM = m.replace(/\s+/g, " ").length >= 20 && !!who;
      const body = res.items.map(i => `${i.target} ${R.keyOf(i.bits)}`).join("\n");
      sub.href = `https://github.com/${CFG.owner}/${CFG.repo}/issues/new?template=challenge_batch.yml&title=${encodeURIComponent(`Challenge entries: ${res.items.map(i => i.target).join(", ")}`)}` +
        `&name=${encodeURIComponent(who)}&entries=${encodeURIComponent(body)}&method=${encodeURIComponent(m.slice(0, 1500))}`;
      if (okM) sub.removeAttribute("aria-disabled"); else sub.setAttribute("aria-disabled", "true");
      sub.textContent = okM ? `Submit ${n} entr${n === 1 ? "y" : "ies"} to the challenge` : !who ? "Enter your name above to submit" : "Describe your method above (at least 20 characters) to submit";
    };
    sub.target = "_blank"; sub.rel = "noopener";
    $("ch-method").oninput = update;
    R.onName(update);
    update();
    const msg = h("p", "send-msg"); msg.hidden = true; msg.setAttribute("role", "status");
    if (CFG.submitUrl && !R.DEMO) {
      const alt = h("p", "fineprint", R.NO_ACCOUNT_NOTE + " The patterns are tested one after another, and each score is added to the leaderboard. ");
      const g = h("a", null, "Submit through GitHub instead"); g.target = "_blank"; g.rel = "noopener";
      alt.append(g);
      const syncGh = () => { g.href = sub.href; };
      syncGh(); R.onName(syncGh); $("ch-method").addEventListener("input", syncGh);
      box.append(sub, msg, alt);
      R.wireDirect(sub, () => ({ kind: "challenge_batch", name: R.yourName(), method: $("ch-method").value.trim(),
        entries: res.items.map(i => ({ target: i.target, pattern: i.bits.join("") })) }), msg);
    } else box.append(sub, msg, h("p", "fineprint", "Nothing has been sent yet. Submitting opens one pre-filled request on GitHub (free account needed). The patterns are tested one after another, and each score is posted on the request and added to the leaderboard. Cancel removes the zip from this page."));
    const cancel = h("button", "admin-btn check-cancel", "Cancel and remove this zip"); cancel.type = "button";
    cancel.onclick = () => {
      box.hidden = true; box.innerHTML = ""; delete box.dataset.state;
      const btn = document.querySelector("#ch-drop .drop-button"); if (btn) { btn.scrollIntoView({ behavior: "smooth", block: "center" }); btn.focus({ preventScroll: true }); }
    };
    const actions = h("div", "check-actions"); sub.replaceWith(actions); actions.append(sub, cancel);
    if (!method) $("ch-method").focus();
  }

  // ---------------------------------------------------------------- standard data split (docs/data/split/)
  async function splitInfo() {
    const idx = await getJSON("data/split/index.json");
    return idx.versions.find(v => v.name === idx.current) || idx.versions[idx.versions.length - 1];
  }
  async function showSplit() {
    if (!$("split-rows")) return;
    try {
      const v = await splitInfo();
      $("split-rows").textContent = R.fmt(v.rows); $("split-last").textContent = R.fmt(v.rows - 1);
      $("split-train").textContent = R.fmt(v.train); $("split-val").textContent = R.fmt(v.validation); $("split-test").textContent = R.fmt(v.test);
      $("split-download").textContent = `Download the split, Benchmark ${v.rows / 1000}k (.zip)`;
    } catch (e) { /* keep the default numbers */ }
  }
  async function downloadSplit() {
    const note = $("split-note"), btn = $("split-download");
    btn.disabled = true; note.textContent = "Preparing the zip…";
    try {
      const v = await splitInfo();
      const files = await Promise.all(["train", "validation", "test"].map(async f => { const r = await fetch(`data/split/${v.name}/${f}.txt`); if (!r.ok) throw new Error(f); return [f + ".txt", await r.text()]; }));
      const zip = new JSZip();
      files.forEach(([name, text]) => zip.file(name, text));
      try { const r = await fetch("data/split/other_patterns.txt"); if (r.ok) zip.file("other_patterns.txt", await r.text()); } catch (e) { /* optional */ }
      const site = `https://${CFG.owner}.github.io/${CFG.repo}/`;
      zip.file("README.txt", `STANDARD DATA SPLIT: BENCHMARK ${v.rows / 1000}K
${"=".repeat(78)}
${CFG.labName || ""}, Purdue University. Downloaded ${new Date().toISOString().slice(0, 10)} from ${site}challenge.html

The benchmark set is the first ${R.fmt(v.rows)} runs of the data set that follow the ISLAND
ALGORITHM, in data-set row order. Row numbers below are rows of codeData.npy, dataData.npy
and maxData.npy from ${site}data.html.

train.txt             ${R.fmt(v.train)} row numbers: train only on these
validation.txt        ${R.fmt(v.validation)} row numbers: tune your model on these
test.txt              ${R.fmt(v.test)} row numbers: report your accuracy on these, never train on them
other_patterns.txt    rows with random insert placement. They are in the full data set but
                      NOT in the benchmark. Use them for extra experiments if you wish, and
                      say so with your method.

HOW IT IS MADE
  Only runs that follow the island algorithm are used (island.npy = 1 in the data set
  download). They are taken in row order and split in blocks of 10,000. Each block is
  shuffled once with a fixed seed and divided into 7,500 training, 1,250 validation and
  1,250 test rows. The benchmark grows in steps of 10,000 island runs (20k, 30k, ...) and
  a row's role never changes between versions.

LOADING (Python)
  import numpy as np
  C = np.load("codeData.npy"); D = np.load("dataData.npy"); M = np.load("maxData.npy")
  train = np.loadtxt("train.txt", dtype=int)
  C[train], D[train], M[train]        # same for validation.txt and test.txt

State the benchmark version you used (for example "Benchmark ${v.rows / 1000}k") with your method.
The ten challenge targets are separate: their patterns are in none of these sets.
`);
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${v.name}_split.zip`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      note.textContent = `Downloaded Benchmark ${v.rows / 1000}k: ${R.fmt(v.train)} training, ${R.fmt(v.validation)} validation and ${R.fmt(v.test)} test rows.`;
    } catch (e) { note.textContent = "The download could not be prepared (" + e.message + ")."; }
    btn.disabled = false;
  }

  function setupUpload() {
    if (!$("ch-zip")) return;
    $("ch-download").onclick = downloadTargets;
    if ($("split-download")) { $("split-download").onclick = downloadSplit; showSplit(); }
    const input = $("ch-zip"), drop = $("ch-drop");
    const handle = async file => {
      if (!file) return;
      if (!targets.length) { try { targets = (await getJSON("data/challenge.json")).targets; } catch (e) { /* shown below */ } }
      const box = $("ch-check"); box.hidden = false; box.dataset.state = "busy"; box.textContent = `Checking ${file.name} …`;
      showEntriesCheck(file, await checkEntriesZip(file));
    };
    input.addEventListener("change", () => { handle(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => handle(e.dataTransfer.files[0]));
  }

  // ---------------------------------------------------------------- data-set explorer
  const AX = [
    { key: "disp", name: "Displacement at 20 N (mm)" }, { key: "inserts", name: "Inserts" }, { key: "islands", name: "Islands" },
    { key: "largest", name: "Largest island (cells)" }, { key: "events", name: "Buckling events" }];
  let X = null;   // loaded data
  async function loadExplorer() {
    const head = await getJSON("data/explorer.json");
    // the .bin is named after its size, so a browser never pairs a new explorer.json with an old cached .bin
    const need = head.metrics.offset + head.metrics.bytes;
    let buf = await (await fetch(`data/explorer.bin?n=${head.n}&b=${need}`)).arrayBuffer();
    if (buf.byteLength < need) buf = await (await fetch(`data/explorer.bin?n=${head.n}&b=${need}`, { cache: "reload" })).arrayBuffer();
    if (buf.byteLength < need) throw new Error("explorer data incomplete");
    const n = head.n;
    const P = new Uint8Array(buf, head.patterns.offset, head.patterns.bytes);
    const M = new Float32Array(buf.slice(head.max_displacement_mm.offset, head.max_displacement_mm.offset + head.max_displacement_mm.bytes));
    const C = new Uint8Array(buf, head.curves.offset, head.curves.bytes);
    const Mt = new Uint8Array(buf, head.metrics.offset, head.metrics.bytes);
    // newer runs from the queue and automatic testing, added after the published ones (same order as the download)
    const adds = R.datasetAdditions ? await R.datasetAdditions() : [];
    const pts = head.curve_points, m = adds.length, nn = n + m;
    const P2 = new Uint8Array(nn * 14), M2 = new Float32Array(nn), C2 = new Uint8Array(nn * pts), Mt2 = new Uint8Array(nn * 5);
    P2.set(P); M2.set(M); C2.set(C); Mt2.set(Mt);
    adds.forEach((a, j) => {
      const i = n + j;
      a.bits.forEach((b, p) => { if (b) P2[i * 14 + (p >> 3)] |= 1 << (7 - (p & 7)); });
      M2[i] = a.max;
      const F = a.data.map(v => (v + 1) * 10);
      for (let k = 0; k < pts; k++) C2[i * pts + k] = Math.max(0, Math.min(255, Math.round((F[Math.round(k * 199 / (pts - 1))] + 0.5) / 21 * 250)));
      const isl = window.RigIsland.islands(a.bits);
      Mt2.set([a.bits.reduce((x, y) => x + y, 0), isl.count, isl.largest, Math.min(255, bucklingEvents(F)), a.island ? 1 : 0], i * 5);
    });
    const col = k => Float32Array.from({ length: nn }, (_, i) => Mt2[i * 5 + k]);
    X = { n: nn, P: P2, M: M2, C: C2, pts, v: { disp: M2, inserts: col(0), islands: col(1), largest: col(2), events: col(3) }, isl: col(4) };
    buildExplorer();
  }
  // same rule as buckling_events() in lab/build_web_dataset.py
  function bucklingEvents(F) {
    const thr = 0.015 * Math.max(...F); let n = 0, peak = F[0], armed = true;
    for (const v of F.slice(1)) {
      if (armed) { if (v > peak) peak = v; else if (peak - v > thr) { n++; armed = false; } }
      else if (v > peak) { peak = v; armed = true; }
    }
    return n;
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
    const DTOP = Math.ceil(Math.max(60, ...X.M));   // covers the longest run
    const dmin = num("20 N from (mm)", 0, 0.5), dmax = num("to", DTOP, 0.5);
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
      count.textContent = vis.length === X.n ? `Showing all ${R.fmt(X.n)} runs` : `Showing ${R.fmt(vis.length)} of ${R.fmt(X.n)} runs`;
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
      open.onclick = () => { location.href = R.pageUrl("submit.html", { pattern: bits.join("") }) + "#single"; };
      const copy = h("button", "ex-copy", "Copy the 105-digit code"); copy.type = "button";
      copy.onclick = async () => { try { await navigator.clipboard.writeText(bits.join("")); copy.textContent = "Copied"; } catch (e) { copy.textContent = bits.join(""); } };
      detail.append(open, copy, h("p", "fineprint", "Row number in the downloaded data set. The curve here is a 50-point preview. The download has all 200 points."));
    }
    [sx, sy, si, ev].forEach(s => s.addEventListener("change", filter));
    [nmin, nmax, dmin, dmax].forEach(s => s.addEventListener("input", filter));
    reset.onclick = () => { sx.value = "inserts"; sy.value = "disp"; si.value = "all"; ev.value = "0"; nmin.value = 0; nmax.value = 105; dmin.value = 0; dmax.value = DTOP; filter(); };
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 150); });
    filter();
  }
  function setupExplorer() {
    if (!$("explorer")) return;
    const start = () => loadExplorer().catch(() => { $("explorer-app").innerHTML = '<p class="empty-note">The explorer data could not be loaded.</p>'; });
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "800px" });
      io.observe($("explorer"));
    } else start();
  }

  window.RigExtras = { onStatus, openReplay, onPattern: null };
  if ($("targets") || $("challenge-banner")) setupChallenge();
  setupUpload();
  setupExplorer();
})();
