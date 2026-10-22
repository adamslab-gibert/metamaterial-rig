/* Admin page: queue control, pause/resume, leaderboard cleanup, blocked accounts, admin login.
   Every change goes to GitHub with the admin's key (unlocked by admin-gate.js). The lab agent reads
   control/rig.json (pause/resume) and control/blocked.json; the request checker reads blocked.json too. */
(function () {
  "use strict";
  const CFG = window.RIG_CONFIG || {};
  const AUTH = window.RigAdminAuth;
  const R = window.Rig;
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
  const BRANCH = CFG.branch || "main";
  const $ = id => document.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };
  const MIN_PW = 8;

  // ---------------------------------------------------------------- GitHub with the admin key
  async function api(method, path, body, okStatus = []) {
    const r = await fetch(API + path, {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + AUTH.token(), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.ok || okStatus.includes(r.status)) return r.status === 204 || !r.headers.get("content-type") ? null : r.json().catch(() => null);
    let msg = ""; try { msg = (await r.json()).message || ""; } catch (e) { /* no body */ }
    const err = new Error(r.status === 401 ? "The admin key is no longer valid (expired or deleted). Use “Replace the GitHub key”."
      : r.status === 403 || r.status === 404 && method !== "GET" ? `GitHub refused this (${r.status}${msg ? ": " + msg : ""}). The admin key needs Contents and Issues: Read and write.`
      : `GitHub answered ${r.status}${msg ? ": " + msg : ""}`);
    err.status = r.status; throw err;
  }
  const utf8ToB64 = s => btoa(unescape(encodeURIComponent(s)));
  const b64ToUtf8 = s => decodeURIComponent(escape(atob(s.replace(/\s/g, ""))));
  async function readFile(path) {
    const f = await api("GET", `/contents/${path}?ref=${BRANCH}`, null, [404]);
    if (!f || !f.content && f.message) return { text: null, sha: null };
    return { text: b64ToUtf8(f.content || ""), sha: f.sha };
  }
  async function readJson(path, fallback) {
    const { text, sha } = await readFile(path);
    let data = fallback;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = fallback; } }
    return { data, sha };
  }
  async function writeText(path, text, sha, message) {
    return api("PUT", `/contents/${path}`, { message, content: utf8ToB64(text), branch: BRANCH, ...(sha ? { sha } : {}) });
  }
  /** Read a JSON file, change it with mutate(data) and save; retries if someone saved in between. */
  async function updateJson(path, fallback, mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await readJson(path, fallback);
      const next = mutate(JSON.parse(JSON.stringify(data)));
      try { await writeText(path, JSON.stringify(next, null, 1) + "\n", sha, message); return next; }
      catch (e) { if (e.status !== 409 && e.status !== 422 || attempt === 2) throw e; }
    }
  }
  async function ensureLabel(name, color, description) {
    await api("POST", "/labels", { name, color, description }, [422]);
  }
  const addLabels = (n, labels) => api("POST", `/issues/${n}/labels`, { labels });
  const removeLabel = (n, name) => api("DELETE", `/issues/${n}/labels/${encodeURIComponent(name)}`, null, [404]);
  const comment = (n, body) => api("POST", `/issues/${n}/comments`, { body });
  async function listOpen(params) {
    let out = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await api("GET", `/issues?state=open&per_page=100&page=${page}${params || ""}`);
      out = out.concat(batch.filter(i => !i.pull_request));
      if (batch.length < 100) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- feedback
  let toastTimer = null;
  function toast(text, bad) {
    const t = $("admin-toast");
    t.textContent = text; t.className = "wrap admin-toast show" + (bad ? " bad" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "wrap admin-toast"; }, bad ? 12000 : 6000);
  }
  async function act(button, label, fn) {
    const all = document.querySelectorAll("#admin-app button");
    all.forEach(b => { b.disabled = true; });
    const old = button ? button.textContent : "";
    if (button) button.textContent = label + "…";
    try { const msg = await fn(); if (msg) toast(msg); }
    catch (e) { toast(e.message, true); }
    finally { if (button) button.textContent = old; all.forEach(b => { b.disabled = false; }); load(); }
  }

  // ---------------------------------------------------------------- helpers for requests
  const has = (i, n) => (i.labels || []).some(l => (l.name || l) === n);
  function patternOf(body) {
    if (!body) return null;
    const sec = body.split(/^###\s+/m).find(s => /^pattern/i.test(s));
    const m = (sec ? sec.replace(/^.*\n/, "") : body).replace(/[ \t\r\n,]/g, "").match(/[01]{105}/);
    return m ? [...m[0]].map(Number) : null;
  }
  function batchCount(body) {
    const m = (body || "").match(/[01]{105}/g);
    return m ? m.length : 0;
  }
  function kindOf(i) {
    const n = batchCount(i.body);
    if (has(i, "batch-request")) return `${has(i, "challenge") ? "Challenge entries" : "Batch"}, ${n} pattern${n === 1 ? "" : "s"}`;
    const p = patternOf(i.body);
    return `${has(i, "challenge") ? "Challenge entry" : "1 pattern"}${p ? ", " + p.reduce((a, b) => a + b, 0) + " inserts" : ""}`;
  }
  function stateOf(i) {
    if (has(i, "running")) return ["Running", "run"];
    if (has(i, "failed")) return ["Failed", "bad"];
    if (has(i, "invalid")) return ["Needs fixing", "bad"];
    if (has(i, "awaiting-approval")) return ["Waiting for approval", "wait"];
    if (has(i, "queued")) return [has(i, "priority") ? "Waiting · front" : "Waiting", has(i, "priority") ? "front" : ""];
    return ["Being checked", ""];
  }
  const order = i => has(i, "running") ? 0 : has(i, "queued") && has(i, "priority") ? 1 : has(i, "queued") ? 2 : has(i, "awaiting-approval") ? 3 : 4;

  async function removeRequest(i, why) {
    await ensureLabel("cancelled", "8A96A0", "Removed from the queue by the lab");
    await comment(i.number, why || "**Removed from the queue by the lab.** If you think this is a mistake, open a new request or contact the lab.");
    for (const l of ["queued", "awaiting-approval", "priority", "invalid", "failed"]) if (has(i, l)) await removeLabel(i.number, l);
    await addLabels(i.number, ["cancelled"]);
    await api("PATCH", `/issues/${i.number}`, { state: "closed", state_reason: "not_planned" });
  }

  function button(text, cls, onclick) {
    const b = document.createElement("button"); b.type = "button"; b.className = cls || "admin-btn"; b.textContent = text; b.onclick = () => onclick(b); return b;
  }

  // ---------------------------------------------------------------- sections
  function showRequests(issues) {
    const body = $("a-queue-body");
    const rows = issues.filter(i => has(i, "pattern-request")).sort((a, b) => order(a) - order(b) || new Date(a.created_at) - new Date(b.created_at));
    $("a-queue-sum").textContent = rows.length ? `${rows.length} open request${rows.length === 1 ? "" : "s"}` : "None open";
    body.innerHTML = "";
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty-note">No open requests.</td></tr>'; return; }
    for (const i of rows) {
      const tr = document.createElement("tr");
      if (has(i, "running")) tr.className = "running";
      const td = label => { const c = document.createElement("td"); c.dataset.label = label; tr.appendChild(c); return c; };
      const req = document.createElement("div"); req.className = "q-req-in";
      const p = has(i, "batch-request") ? null : patternOf(i.body);
      if (p) req.appendChild(R.thumb(p));
      else { const ic = document.createElement("span"); ic.className = "batch-icon"; ic.textContent = batchCount(i.body) || "?"; req.appendChild(ic); }
      const who = document.createElement("div");
      who.innerHTML = `<a href="${i.html_url}" target="_blank" rel="noopener">#${i.number}</a><span class="sub"></span>`;
      who.querySelector(".sub").textContent = "by " + ((R.nameFromBody && R.nameFromBody(i.body)) || (i.user ? i.user.login : "unknown")) +
        (i.user ? " · @" + i.user.login : "");
      req.appendChild(who);
      const c1 = td("Request"); c1.className = "q-req"; c1.appendChild(req);
      td("Patterns").textContent = kindOf(i);
      const [st, cls] = stateOf(i);
      const chip = document.createElement("span"); chip.className = "chip " + cls; chip.textContent = st; td("Status").appendChild(chip);
      const w = td("Submitted"); w.className = "q-when"; w.textContent = R.ago(i.created_at);
      const a = document.createElement("div"); a.className = "admin-acts"; const ac = td("Actions"); ac.className = "admin-actions"; ac.appendChild(a);
      if (has(i, "running")) {
        const s = document.createElement("span"); s.className = "sub"; s.textContent = "Stop with Halt now above"; a.appendChild(s);
      } else {
        if (has(i, "queued")) a.appendChild(has(i, "priority")
          ? button("Undo front", "admin-btn", b => act(b, "Saving", async () => { await removeLabel(i.number, "priority"); return `#${i.number} is back in normal order.`; }))
          : button("Move to front", "admin-btn", b => act(b, "Moving", async () => {
              await ensureLabel("priority", "E9A23B", "Moved to the front of the queue by the lab");
              await addLabels(i.number, ["priority"]); return `#${i.number} runs next (after the test that is running).`;
            })));
        if (has(i, "awaiting-approval")) a.appendChild(button("Approve", "admin-btn", b => act(b, "Approving", async () => {
          await removeLabel(i.number, "awaiting-approval"); await addLabels(i.number, ["queued"]);
          await comment(i.number, "**Approved by the lab.** It is now in the queue."); return `#${i.number} approved and queued.`;
        })));
        if (has(i, "failed")) a.appendChild(button("Retry", "admin-btn", b => act(b, "Queuing", async () => {
          await removeLabel(i.number, "failed"); await addLabels(i.number, ["queued"]);
          await comment(i.number, "**Put back in the queue by the lab.** It runs again when the rig is free."); return `#${i.number} is back in the queue.`;
        })));
        a.appendChild(button("Remove", "admin-btn danger", b => {
          if (!window.confirm(`Remove request #${i.number} by ${i.user ? i.user.login : "unknown"} from the queue? It is closed and its author gets a comment.`)) return;
          act(b, "Removing", async () => { await removeRequest(i); return `#${i.number} removed.`; });
        }));
      }
      body.appendChild(tr);
    }
  }

  let lastControl = null;
  function showControl(ctl) {
    lastControl = ctl;
    const now = $("ctl-now");
    if (!ctl || ctl.accepting === undefined) now.textContent = "Web jobs: not set from this page yet (the rig computer decides).";
    else now.innerHTML = ctl.accepting
      ? `Web jobs: <strong>allowed</strong> <span class="sub">(set ${R.ago(ctl.updated)})</span>`
      : `Web jobs: <strong>paused</strong>${ctl.note ? " – “" + escapeHtml(ctl.note) + "”" : ""} <span class="sub">(set ${R.ago(ctl.updated)})</span>`;
    $("a-rig-sum").textContent = "";
    const auto = !ctl || ctl.auto_fill !== false;
    $("auto-now").innerHTML = `<span class="dot ${auto ? "on" : "off"}" aria-hidden="true"></span>Automatic testing: <strong>${auto ? "on" : "off"}</strong>`;
    $("btn-auto").textContent = auto ? "Turn automatic testing off" : "Turn automatic testing on";
    $("btn-auto").dataset.on = auto ? "1" : "";
    const maint = !!(ctl && ctl.maintenance);
    $("maint-now").innerHTML = maint
      ? "Maintenance mode: <strong>on</strong>. Web jobs and automatic testing are off, and single-axis moves are allowed."
      : "Maintenance mode: <strong>off</strong>. Turn it on to move single axes (it pauses web jobs and automatic testing first).";
    $("btn-maint").textContent = maint ? "Turn maintenance mode off (and resume web jobs)" : "Turn maintenance mode on";
    $("btn-maint").dataset.on = maint ? "1" : "";
    $("maint-tools").hidden = !maint;
  }
  /** Change control/rig.json (read by the lab agent). Keeps the fields that are not changed. */
  function setControl(fields, message) {
    return updateJson("control/rig.json", {}, d => {
      const next = { ...d, home: false, ...fields, updated: new Date().toISOString() };
      if (fields.command)                     // keep recent commands, so quick clicks are not lost between two checks
        next.commands = [...(Array.isArray(d.commands) ? d.commands : []), fields.command].slice(-20);
      return next;
    }, message);
  }

  function showLeaderboard(board) {
    const body = $("a-lb-body");
    body.innerHTML = "";
    $("a-lb-sum").textContent = board.length ? `${board.length} entr${board.length === 1 ? "y" : "ies"}` : "Empty";
    if (!board.length) { body.innerHTML = '<tr><td colspan="5" class="empty-note">No challenge entries yet.</td></tr>'; return; }
    const rows = board.slice().sort((a, b) => String(a.target).localeCompare(String(b.target), undefined, { numeric: true }) || a.score_N - b.score_N);
    for (const e of rows) {
      const tr = document.createElement("tr");
      const td = label => { const c = document.createElement("td"); c.dataset.label = label; tr.appendChild(c); return c; };
      td("Target").innerHTML = `<strong></strong>`; tr.lastChild.firstChild.textContent = e.target;
      const who = td("Entry");
      who.innerHTML = `<a target="_blank" rel="noopener"></a> <span class="sub"></span>`;
      who.firstChild.href = `https://github.com/${CFG.owner}/${CFG.repo}/issues/${e.issue}`;
      who.firstChild.textContent = `#${e.issue}${e.batch_index != null ? " · " + (e.batch_index + 1) : ""}`;
      who.lastChild.textContent = "by " + (e.name || e.user || "unknown") + (e.user && e.name && e.name !== e.user ? " · @" + e.user : "");
      td("Score").textContent = e.score_N != null ? e.score_N.toFixed(3) + " N" : "–";
      const w = td("Tested"); w.className = "q-when"; w.textContent = e.tested_at ? R.ago(e.tested_at) : "–";
      const a = document.createElement("div"); a.className = "admin-acts"; const ac = td("Actions"); ac.className = "admin-actions"; ac.appendChild(a);
      a.appendChild(button("Remove", "admin-btn danger", b => {
        if (!window.confirm(`Remove the ${e.target} entry #${e.issue} by ${e.user} from the leaderboard?`)) return;
        act(b, "Removing", async () => {
          await updateJson("results/leaderboard.json", [], d => d.filter(x => !(x.issue === e.issue && (x.batch_index ?? null) === (e.batch_index ?? null))),
            `Admin: remove leaderboard entry #${e.issue}${e.batch_index != null ? "/" + e.batch_index : ""}`);
          return `Entry #${e.issue} removed from the leaderboard. The Challenge page shows it within a minute or two.`;
        });
      }));
      body.appendChild(tr);
    }
  }

  function showBlocked(list) {
    const ul = $("a-blocked");
    ul.innerHTML = "";
    if (!list.length) { ul.innerHTML = '<li class="empty-note">Nobody is blocked.</li>'; return; }
    for (const u of list) {
      const li = document.createElement("li");
      const a = document.createElement("a"); a.href = "https://github.com/" + encodeURIComponent(u); a.target = "_blank"; a.rel = "noopener"; a.textContent = u;
      li.appendChild(a);
      li.appendChild(button("Unblock", "admin-btn", b => act(b, "Unblocking", async () => {
        await updateJson("control/blocked.json", { users: [] }, d => ({ users: (d.users || []).filter(x => x.toLowerCase() !== u.toLowerCase()), updated: new Date().toISOString() }),
          `Admin: unblock ${u}`);
        return `${u} can submit requests again.`;
      })));
      ul.appendChild(li);
    }
  }
  function showPositions(issue) {
    const m = issue && issue.body && issue.body.match(/```json\s*([\s\S]*?)```/);
    let st = null; try { st = m ? JSON.parse(m[1]) : null; } catch (e) { /* not readable */ }
    const p = st && st.pos;
    const f = v => (+v).toFixed(2);
    $("pos-now").innerHTML = p
      ? `Ender 0: X ${f(p[0][0])} · Y ${f(p[0][1])} · Z ${f(p[0][2])} &nbsp;|&nbsp; Ender 1: X ${f(p[1][0])} · Z ${f(p[1][2])} <span class="sub">(${R.ago(st.updated)})</span>`
      : "Positions: not reported yet (they appear when the rig is idle, with the newest rig program).";
  }
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------------------------------------------------------------- load everything
  let loading = false;
  async function load() {
    if (loading || $("admin-app").hidden) return;
    loading = true;
    try {
      const [issues, ctl, board, blocked, statusIssues] = await Promise.all([
        listOpen("").then(l => l.filter(i => has(i, "pattern-request"))),
        readJson("control/rig.json", null),
        readJson("results/leaderboard.json", []),
        readJson("control/blocked.json", { users: [] }),
        listOpen("").then(l => l.filter(i => has(i, "machine-status"))).catch(() => [])
      ]);
      showPositions(statusIssues[0]);
      showRequests(issues); showControl(ctl.data);
      showLeaderboard(Array.isArray(board.data) ? board.data : []);
      showBlocked((blocked.data && blocked.data.users) || []);
    } catch (e) {
      toast(e.message, true);
      if (e.status === 401) { AUTH.logout(); start(); }
    } finally { loading = false; }
  }

  function wire() {
    $("btn-pause").onclick = ev => act(ev.target, "Pausing", async () => {
      await setControl({ accepting: false, note: $("pause-note").value.trim() }, "Admin: pause web jobs");
      return "Web jobs paused. The rig computer picks this up within about 20 seconds.";
    });
    $("btn-resume").onclick = ev => act(ev.target, "Resuming", async () => {
      await setControl({ accepting: true, note: "" }, "Admin: resume web jobs");
      return "Web jobs allowed again. The rig computer picks this up within about 20 seconds.";
    });
    $("btn-stop").onclick = ev => {
      if (!window.confirm("Stop after the test that is running now? The rig finishes that pattern, homes both Enders and takes no new jobs until you press Resume. A batch continues where it stopped.")) return;
      act(ev.target, "Stopping", async () => {
        await setControl({ accepting: false, home: true, note: $("pause-note").value.trim() || "Stopped by the lab." }, "Admin: stop after this test and home");
        return "Stopping: the running test finishes, then the rig homes and waits. Press Resume web jobs to continue.";
      });
    };
    const CMD = {
      start_program: ["Starting", "Start the rig program on the rig computer?", "The rig program is being started. Then use Connect & home."],
      restart_program: ["Restarting", "Close and reopen the rig program? A test that is running is interrupted.", "The rig program is being restarted. Then use Connect & home."],
      stop_program: ["Closing", "Close the rig program? A test that is running is interrupted and the website shows Offline.", "The rig program is being closed."],
      setup: ["Connecting", "Connect both Enders and the Mark-10, load the coordinates and home both Enders? The machine will move.", "Connecting and homing. The status turns to Online and ready when it is done."],
      home: ["Homing", "Home both Enders now? The machine will move (after the running test, if any).", "Homing both Enders."],
      estop: ["Stopping", "EMERGENCY STOP: both Enders stop at once, mid-move, and must then be switched off and on, reconnected and homed. It arrives in 20–30 seconds. In a real emergency, switch off the power at the rig. Send it?", "Emergency stop sent. Afterwards: switch the Enders off and on, use Connect & home, then Resume web jobs."],
      halt: ["Halting", "Halt the rig now? The running test stops at once, is marked failed, and web jobs pause.", "Halt sent. Press Resume web jobs after checking the machine."]
    };
    document.querySelectorAll("[data-cmd]").forEach(btn => {
      btn.onclick = () => {
        const [busy, question, done] = CMD[btn.dataset.cmd];
        if (!window.confirm(question)) return;
        act(btn, busy, async () => {
          const at = new Date().toISOString();
          await setControl({ command: { id: btn.dataset.cmd + "-" + Date.now(), action: btn.dataset.cmd, at } }, "Admin: " + btn.dataset.cmd.replace("_", " "));
          return done + " It reaches the rig computer within about 30 seconds.";
        });
      };
    });
    const axisSel = $("mv-axis");
    $("mv-ender").onchange = () => {
      const one = $("mv-ender").value === "1";
      axisSel.querySelector("option[value=Y], option:nth-child(2)").disabled = one;
      if (one && axisSel.value === "Y") axisSel.value = "X";
    };
    const move = sign => ev => {
      const ender = +$("mv-ender").value, axis = axisSel.value, mm = sign * parseFloat($("mv-step").value);
      act(ev.target, "Sending", async () => {
        await setControl({ command: { id: "move-" + Date.now(), action: "move", at: new Date().toISOString(), ender, axis, mm } },
          `Admin: move Ender ${ender} ${axis} ${mm > 0 ? "+" : ""}${mm} mm`);
        return `Move sent: Ender ${ender} ${axis} ${mm > 0 ? "+" : ""}${mm} mm. It runs within about 30 seconds if no test is running.`;
      });
    };
    $("btn-maint").onclick = ev => {
      const on = !ev.target.dataset.on;
      if (on && !window.confirm("Turn maintenance mode on? Web jobs pause (a running test finishes first), then single-axis moves are allowed.")) return;
      act(ev.target, on ? "Turning on" : "Turning off", async () => {
        // maintenance also switches automatic testing off; turning maintenance off restores it if it was on before
        const autoWas = !!$("btn-auto").dataset.on;
        await setControl(on ? { maintenance: true, accepting: false, note: "Maintenance in progress.", auto_fill: false, auto_resume: autoWas }
                            : { maintenance: false, accepting: true, note: "", auto_fill: lastControl && lastControl.auto_resume !== undefined ? !!lastControl.auto_resume : true },
          on ? "Admin: maintenance mode on" : "Admin: maintenance mode off");
        return on ? "Maintenance mode is on and automatic testing is off. The move controls are below. They work once any running test has finished."
                  : "Maintenance mode is off. Web jobs are allowed again" + (lastControl && lastControl.auto_resume === false ? "." : ", and automatic testing is back on.");
      });
    };
    $("mv-minus").onclick = move(-1);
    $("mv-plus").onclick = move(1);
    $("btn-auto").onclick = ev => {
      const on = !ev.target.dataset.on;
      act(ev.target, on ? "Turning on" : "Turning off", async () => {
        await setControl({ auto_fill: on }, on ? "Admin: automatic testing on" : "Admin: automatic testing off");
        return on ? "Automatic testing is on." : "Automatic testing is off. An automatic pattern that is already running finishes first.";
      });
    };
    $("block-form").onsubmit = ev => {
      ev.preventDefault();
      const user = $("block-user").value.trim().replace(/^@/, "");
      if (!user) return;
      const closeToo = $("block-close").checked;
      if (!window.confirm(`Block ${user}?${closeToo ? " Their waiting requests are removed too." : ""}`)) return;
      act(ev.submitter, "Blocking", async () => {
        await updateJson("control/blocked.json", { users: [] }, d => {
          const users = (d.users || []).filter(x => x.toLowerCase() !== user.toLowerCase());
          users.push(user); return { users: users.sort((a, b) => a.localeCompare(b)), updated: new Date().toISOString() };
        }, `Admin: block ${user}`);
        let closed = 0;
        if (closeToo) {
          const theirs = (await listOpen(`&creator=${encodeURIComponent(user)}`)).filter(i => has(i, "pattern-request") && !has(i, "running"));
          for (const i of theirs) {
            await removeRequest(i, "**Removed by the lab.** This account can no longer submit requests to the rig.");
            closed++;
          }
        }
        $("block-user").value = "";
        return `${user} is blocked.${closeToo ? ` ${closed} waiting request${closed === 1 ? "" : "s"} removed.` : ""}`;
      });
    };
    $("pw-form").onsubmit = ev => {
      ev.preventDefault();
      const pw = $("pw-new").value, pw2 = $("pw-new2").value, msg = $("pw-msg");
      if (pw.length < MIN_PW) { msg.textContent = `Use at least ${MIN_PW} characters.`; msg.className = "admin-msg bad"; return; }
      if (pw !== pw2) { msg.textContent = "The two passwords differ."; msg.className = "admin-msg bad"; return; }
      act(ev.submitter, "Saving", async () => {
        await saveKey(AUTH.token(), pw, "Admin: change admin password");
        $("pw-new").value = $("pw-new2").value = ""; msg.textContent = "";
        return "Password changed. The new password works once the site has updated (about a minute).";
      });
    };
    $("btn-replace").onclick = () => { $("setup-title").textContent = "Replace the GitHub key"; show("admin-setup", true); $("setup-token").focus(); };
    $("btn-logout").onclick = () => { AUTH.logout(); location.href = "index.html"; };
  }

  // ---------------------------------------------------------------- login and setup
  async function saveKey(token, password, message) {
    const blob = await AUTH.encryptToken(token, password);
    const path = "docs/assets/admin_key.json";
    const prev = await api("GET", `/contents/${path}?ref=${BRANCH}`, null, [404]);
    await writeText(path, JSON.stringify(blob, null, 1) + "\n", prev && prev.sha, message);
  }

  async function start() {
    show("admin-app", false); show("admin-login", false); show("admin-setup", false);
    if (AUTH.token()) {
      try {
        await api("GET", "");
        show("admin-app", true); load();
        if ($("admin-live") && R.embedLive) R.embedLive($("admin-live"));   // the camera, so the rig can be watched while it is controlled
        return;
      } catch (e) {
        if (e.status === 401) AUTH.logout();
        else { show("admin-app", true); toast(e.message, true); return; }
      }
    }
    let keyFile = null;
    try { keyFile = await AUTH.loadKeyFile(); } catch (e) { /* treat as missing */ }
    if (!keyFile) { $("setup-title").textContent = "Set up the admin login"; show("admin-setup", true); return; }
    show("admin-login", true); $("login-pw").focus();
  }

  $("login-form").onsubmit = async ev => {
    ev.preventDefault();
    const msg = $("login-msg");
    msg.className = "admin-msg"; msg.textContent = "Checking…";
    try { await AUTH.unlock($("login-pw").value); $("login-pw").value = ""; msg.textContent = ""; start(); }
    catch (e) {
      msg.className = "admin-msg bad";
      if (e.message !== "wrong") { msg.textContent = e.message; return; }
      wrongTries++;
      const lines = ["Imposter! That is not the password.", "Still an imposter. Sir Squish-a-Lot is not amused.",
                     "Imposter, third time. The rig has stopped believing you.", "Imposter. Ask a lab member for the password, or make a nice pattern on the Submit page instead."];
      msg.textContent = lines[Math.min(wrongTries, lines.length) - 1];
      msg.classList.add("imposter"); setTimeout(() => msg.classList.remove("imposter"), 700);
      $("login-pw").value = ""; $("login-pw").focus();
    }
  };
  let wrongTries = 0;

  $("setup-form").onsubmit = async ev => {
    ev.preventDefault();
    const token = $("setup-token").value.trim(), pw = $("setup-pw").value, pw2 = $("setup-pw2").value, msg = $("setup-msg");
    const bad = t => { msg.className = "admin-msg bad"; msg.textContent = t; };
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) return bad("That doesn't look like a GitHub key (it starts with github_pat_).");
    if (pw.length < MIN_PW) return bad(`Use a password of at least ${MIN_PW} characters.`);
    if (pw !== pw2) return bad("The two passwords differ.");
    msg.className = "admin-msg"; msg.textContent = "Checking the key and saving…";
    const previous = AUTH.token();
    AUTH.setToken(token);
    try {
      await api("GET", "");
      await saveKey(token, pw, previous ? "Admin: replace admin key" : "Admin: set up admin login");
      $("setup-token").value = $("setup-pw").value = $("setup-pw2").value = "";
      msg.textContent = "";
      show("admin-setup", false); show("admin-app", true); load();
      toast("Admin login saved. From about a minute from now, the password works on every page.");
    } catch (e) {
      if (previous) AUTH.setToken(previous); else AUTH.logout();
      bad(e.status === 401 ? "GitHub did not accept this key. Copy it again, or make a new one." : e.message);
    }
  };

  if (R && R.CFG) { /* app.js loaded: it shows the machine status in #status and the top bar */ }
  wire();
  start();
  setInterval(load, 60000);
})();
