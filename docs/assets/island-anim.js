/* Data page: animation of the island algorithm that generated the data set.
   Same rules as the lab's island_generator.py:
     1. Seeds: K random cells become island cores. A new core may not be a core or a neighbour of one.
     2. Growth: pick a random cell that is still open.
          touches exactly one island  -> it joins that island (insert)
          touches two or more islands -> it stays empty for good (it separates islands)
          touches no island           -> it stays open and may be picked again later
        until no cell is open.
     3. Pattern: island cells get an insert, all other cells stay empty.
   Neighbours share an edge or a corner (up to 8 per cell). */
(function () {
  "use strict";
  const root = document.getElementById("island-anim-app");
  if (!root) return;
  const NS = "http://www.w3.org/2000/svg", N = 105, ROWS = 19;

  // ---- geometry: code position p (bottom row first) <-> row r (0 = top), column c
  const cells = [];
  for (let r = ROWS - 1; r >= 0; r--) (r % 2 === 0 ? [0, 2, 4, 6, 8, 10] : [1, 3, 5, 7, 9]).forEach(c => cells.push({ r, c }));
  function neighbours(cc) {
    let nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 1, cc + 5, cc + 6, cc + 11];
    const m = cc % 11;
    if (m === 0) nb = [cc - 11, cc - 5, cc + 1, cc + 6, cc + 11];
    if (m === 5) nb = [cc - 11, cc - 6, cc - 1, cc + 5, cc + 11];
    if (m === 6) nb = [cc - 11, cc - 6, cc - 5, cc + 1, cc + 5, cc + 6, cc + 11];
    if (m === 10) nb = [cc - 11, cc - 6, cc - 5, cc - 1, cc + 5, cc + 6, cc + 11];
    return nb.filter(x => x >= 0 && x < N);
  }
  const NB = cells.map((_, i) => neighbours(i));

  // ---- the algorithm, recorded as a list of events to play back
  function run(K) {
    const ev = [], island = new Array(N).fill(-1), open = new Array(N).fill(true), cores = [];
    for (let k = 0; k < K; k++) {
      let core, guard = 0;
      do { core = Math.floor(Math.random() * N); guard++; }
      while (guard < 5000 && cores.some(c => c === core || NB[c].includes(core)));
      cores.push(core); island[core] = k; open[core] = false;
      ev.push({ t: "seed", cell: core, k, near: NB[core] });
    }
    let waits = 0;
    for (;;) {
      const pool = [];
      for (let i = 0; i < N; i++) if (open[i]) pool.push(i);
      if (!pool.length) break;
      const t = pool[Math.floor(Math.random() * pool.length)];
      const touch = new Set(NB[t].map(q => island[q]).filter(k => k >= 0));
      if (touch.size === 1) { island[t] = [...touch][0]; open[t] = false; ev.push({ t: "join", cell: t, k: island[t], waits }); waits = 0; }
      else if (touch.size > 1) { open[t] = false; ev.push({ t: "block", cell: t, ks: [...touch], waits }); waits = 0; }
      else waits++;
    }
    ev.push({ t: "islands" });
    ev.push({ t: "done" });
    return { ev, island };
  }

  // ---- drawing
  const colour = k => `hsl(${(k * 137.508 + 20) % 360} 62% 58%)`;
  const diamond = (c, r, s) => `M${c} ${r - s}L${c + s} ${r}L${c} ${r + s}L${c - s} ${r}Z`;
  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const a in attrs) e.setAttribute(a, attrs[a]);
    if (parent) parent.appendChild(e);
    return e;
  }

  root.innerHTML = `
    <div class="ia-stage">
      <svg class="ia-svg" viewBox="-1.55 -2 13.1 22" role="img" aria-label="Animation of the island algorithm on the 105-cell lattice"></svg>
    </div>
    <div class="ia-side">
      <ol class="ia-steps">
        <li data-step="seed"><strong>Plant seeds.</strong> A few cells are picked at random as the first cell of each island. Seeds are never placed next to each other.</li>
        <li data-step="grow"><strong>Grow the islands.</strong> Open cells are picked one by one at random. A cell that touches one island joins it. A cell that touches two or more islands stays empty for good, which keeps the islands apart. A cell that touches no island waits for a later turn.</li>
        <li data-step="done"><strong>Read the pattern.</strong> When no open cells are left, every island cell gets a rigid insert and every other cell stays empty.</li>
      </ol>
      <p class="ia-now" aria-live="polite">Press Play to watch a pattern being made.</p>
      <dl class="ia-count">
        <div><dt>Islands</dt><dd class="ia-k">–</dd></div>
        <div><dt>Inserts</dt><dd class="ia-n">0</dd></div>
        <div><dt>Open cells</dt><dd class="ia-open">105</dd></div>
      </dl>
      <div class="ia-ctl">
        <button type="button" class="submit ia-play">Play</button>
        <button type="button" class="admin-btn ia-step">Step</button>
        <button type="button" class="admin-btn ia-new">New pattern</button>
      </div>
      <div class="ia-ctl ia-opts">
        <label>Islands <select class="ia-kset">${Array.from({ length: 14 }, (_, i) => i + 4).map(k => `<option${k === 7 ? " selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Speed <input class="ia-speed" type="range" min="1" max="5" value="3"></label>
      </div>
      <p class="ia-legend"><span class="ia-sw open"></span>open <span class="ia-sw isl"></span>island <span class="ia-sw blocked"></span>kept empty <span class="ia-sw ins"></span>insert</p>
    </div>`;
  const svg = root.querySelector(".ia-svg"), $ = s => root.querySelector(s);
  el("rect", { class: "ia-plate", x: -1.3, y: -1.75, width: 12.6, height: .75, rx: .12 }, svg);
  el("rect", { class: "ia-plate", x: -1.3, y: 19, width: 12.6, height: .75, rx: .12 }, svg);
  const shapes = cells.map(({ r, c }) => {
    const g = el("g", { class: "ia-cell" }, svg);
    const p = el("path", { d: diamond(c, r, .86) }, g);
    const ring = el("path", { class: "ia-ring", d: diamond(c, r, .98) }, g);
    return { g, p, ring };
  });

  let K = 7, game = null, pos = 0, timer = null, nIns = 0, nOpen = N;
  const speed = () => [0, 420, 240, 120, 55, 20][+$(".ia-speed").value];
  function reset() {
    stop();
    K = +$(".ia-kset").value;
    game = run(K); pos = 0; nIns = 0; nOpen = N;
    shapes.forEach(s => { s.g.setAttribute("class", "ia-cell"); s.p.style.fill = ""; });
    $(".ia-k").textContent = K; $(".ia-n").textContent = 0; $(".ia-open").textContent = N;
    setStep("seed");
    $(".ia-now").textContent = `A new run with ${K} islands. Press Play or Step.`;
  }
  function setStep(name) { root.querySelectorAll(".ia-steps li").forEach(li => li.classList.toggle("on", li.dataset.step === name)); }
  function flash(i, cls) {
    const g = shapes[i].g; g.classList.add(cls);
    setTimeout(() => g.classList.remove(cls), Math.max(250, speed() * 3));
  }
  function apply(e) {
    if (e.t === "seed") {
      setStep("seed");
      const s = shapes[e.cell]; s.g.classList.add("isl", "seed"); s.p.style.fill = colour(e.k);
      e.near.forEach(q => flash(q, "near"));
      nIns++; nOpen--;
      $(".ia-now").textContent = `Seed ${e.k + 1} of ${K} planted. Its neighbours (outlined) can't hold another seed.`;
    } else if (e.t === "join") {
      setStep("grow");
      const s = shapes[e.cell]; s.g.classList.add("isl"); s.p.style.fill = colour(e.k); flash(e.cell, "pick");
      nIns++; nOpen--;
      $(".ia-now").textContent = `This cell touches one island, so it joins that island.`;
    } else if (e.t === "block") {
      setStep("grow");
      shapes[e.cell].g.classList.add("blocked"); flash(e.cell, "pick");
      nOpen--;
      $(".ia-now").textContent = `This cell touches ${e.ks.length} different islands, so it stays empty and keeps them apart.`;
    } else if (e.t === "islands") {
      setStep("grow");
      $(".ia-now").textContent = `Every cell is decided. ${K} islands (coloured) are separated by cells that stay empty (grey).`;
    } else if (e.t === "done") {
      setStep("done");
      shapes.forEach((s, i) => { s.p.style.fill = ""; s.g.setAttribute("class", "ia-cell " + (game.island[i] >= 0 ? "ins" : "final-empty")); });
      $(".ia-now").textContent = `Done: ${nIns} inserts in ${K} islands. Every empty cell now touches at least two islands, which is the rule the data set follows.`;
      stop();
    }
    $(".ia-n").textContent = nIns; $(".ia-open").textContent = nOpen;
  }
  function step() {
    if (!game || pos >= game.ev.length) reset();
    apply(game.ev[pos++]);
  }
  function tick() {
    if (!game || pos >= game.ev.length) { stop(); return; }
    const e = game.ev[pos];
    step();
    if (timer !== null) timer = setTimeout(tick, e.t === "seed" ? Math.max(500, speed() * 4) : e.t === "islands" ? 2200 : speed());
  }
  function play() {
    if (!game || pos >= game.ev.length) reset();
    $(".ia-play").textContent = "Pause";
    timer = 0; tick();
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; $(".ia-play").textContent = pos && game && pos >= game.ev.length ? "Play again" : "Play"; }
  $(".ia-play").onclick = () => (timer !== null ? stop() : play());
  $(".ia-step").onclick = () => { stop(); step(); };
  $(".ia-new").onclick = () => { reset(); play(); };
  $(".ia-kset").onchange = () => reset();
  reset();
  // start by itself when the section scrolls into view (once), unless the visitor prefers less motion
  const still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!still && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); play(); } }, { threshold: .4 });
    io.observe(root);
  }
})();
