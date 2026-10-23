// Checks a pattern request issue and puts it in the queue (or explains what to fix).
// Used by .github/workflows/validate-pattern.yml through actions/github-script.
"use strict";

const N_CELLS = 105;
const MAX_BATCH = 100;      // patterns per batch request (one uploaded zip)
const MARK = "<!-- rig-bot:validation -->";
const LABELS = {
  "pattern-request": ["5B6B7A", "A pattern submitted through the rig page"],
  "batch-request": ["5B6B7A", "Several patterns uploaded as a zip; tested one after another"],
  "challenge": ["7B3FB0", "An entry for an inverse-design challenge target"],
  "queued": ["3256B0", "Checked and waiting for the rig"],
  "awaiting-approval": ["B7791F", "Checked; waiting for a lab member to approve"],
  "running": ["1F7A4D", "Being built and tested now"],
  "done": ["23874F", "Tested; results posted"],
  "failed": ["B23A2B", "The test did not finish; a lab member will look at it"],
  "invalid": ["B23A2B", "The pattern needs fixing"],
  "machine-status": ["8A96A0", "Live status of the rig (updated by the lab computer)"],
  "priority": ["E9A23B", "Moved to the front of the queue by the lab"],
  "cancelled": ["8A96A0", "Removed from the queue by the lab"]
};

/** True for requests sent from the website without a GitHub account (opened by the lab's key). */
function viaWebsite(i) { return (i.user && i.user.login || "").toLowerCase() === String(process.env.SUBMIT_ACCOUNT || "").toLowerCase(); }

/** GitHub accounts blocked on the Admin page (control/blocked.json), lower case. */
function blockedUsers() {
  try {
    const data = JSON.parse(require("fs").readFileSync("control/blocked.json", "utf8"));
    return (data.users || []).filter(u => typeof u === "string").map(u => u.toLowerCase());
  } catch (e) { return []; }
}

/** Pull the 105-digit code out of the issue body (issue-form markdown or plain text). */
function parsePattern(body) {
  if (!body) return { ok: false, why: "The request is empty." };
  const sections = body.split(/^###\s+/m);
  const sec = sections.find(s => /^pattern/i.test(s));
  const text = sec ? sec.replace(/^.*\n/, "") : body;
  const firstBlock = text.trim().split(/\n\s*\n/)[0] || "";
  const cleaned = firstBlock.replace(/[\s,]/g, "");
  if (!cleaned) return { ok: false, why: "The pattern field is empty." };
  if (/[^01]/.test(cleaned)) {
    const bad = [...new Set(cleaned.replace(/[01]/g, ""))].slice(0, 8).join(" ");
    return { ok: false, why: `The pattern may only contain 0 and 1. Found: \`${bad}\`.` };
  }
  if (cleaned.length !== N_CELLS)
    return { ok: false, why: `The pattern has ${cleaned.length} digits; it needs exactly ${N_CELLS}.` };
  return { ok: true, code: cleaned };
}

/** Pull the patterns of a batch request out of the issue body. Each line is one pattern, in index
    order: either 105 digits (bottom row first) or the same pattern as 27 hex digits (the page uses
    hex so a batch of 100 fits in the link that opens the request). Same rules as lab/agent.py. */
function parseBatch(body) {
  if (!body) return { ok: false, why: "The request is empty." };
  const sections = body.split(/^###\s+/m);
  const sec = sections.find(s => /^patterns/i.test(s));
  if (!sec) return { ok: false, why: "The request has no Patterns field. Upload the zip on the rig page and use its submit button." };
  const lines = sec.replace(/^.*\n/, "").split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== "_No response_" && !l.startsWith("```"));
  if (!lines.length) return { ok: false, why: "The Patterns field is empty." };
  if (lines.length > MAX_BATCH) return { ok: false, why: `The request has ${lines.length} patterns; at most ${MAX_BATCH} can be tested per request.` };
  const codes = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k].replace(/[\s,]/g, "");
    if (/^[01]{105}$/.test(l)) { codes.push(l); continue; }
    if (/^[0-9a-fA-F]{27}$/.test(l) && /^[01]/.test(l)) { codes.push(BigInt("0x" + l).toString(2).padStart(N_CELLS, "0")); continue; }
    return { ok: false, why: `Pattern ${k} (line ${k + 1}) is not a valid pattern: it needs 105 digits of 0 and 1.` };
  }
  return { ok: true, codes };
}

/** Challenge entries uploaded as a zip: lines "T3 <pattern>" under the Entries heading (pattern as 105 digits
    or 27 hex digits), at most one pattern per target. Same rules as lab/agent.py. */
const MAX_CHALLENGE_ENTRIES = 10;
function parseChallengeEntries(body) {
  const lines = section(body, "entries").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("```"));
  if (!lines.length) return { ok: false, why: "The Entries field is empty. Upload the zip on the Challenge page and use its submit button." };
  if (lines.length > MAX_CHALLENGE_ENTRIES) return { ok: false, why: `The request has ${lines.length} entries; at most ${MAX_CHALLENGE_ENTRIES} (one per target).` };
  const entries = [], seen = new Set();
  for (let k = 0; k < lines.length; k++) {
    const parts = lines[k].replace(/,/g, " ").split(/\s+/);
    if (parts.length !== 2) return { ok: false, why: `Line ${k + 1} should be a target and a pattern, e.g. "T3 0101…".` };
    const target = parts[0].toUpperCase(), p = parts[1];
    let code = null;
    if (/^[01]{105}$/.test(p)) code = p;
    else if (/^[01][0-9a-fA-F]{26}$/.test(p)) code = BigInt("0x" + p).toString(2).padStart(N_CELLS, "0");
    if (!code) return { ok: false, why: `Line ${k + 1}: the pattern is not valid (105 digits of 0 and 1).` };
    if (seen.has(target)) return { ok: false, why: `Target ${target} appears more than once; enter at most one pattern per target.` };
    seen.add(target); entries.push({ target, code });
  }
  return { ok: true, entries, codes: entries.map(e => e.code) };
}

/** Text under an issue-form heading starting with `name`. */
function section(body, name) {
  const sec = (body || "").split(/^###\s+/m).find(s => s.toLowerCase().startsWith(name.toLowerCase()));
  if (!sec) return "";
  const t = sec.replace(/^.*\n/, "").trim();
  return t === "_No response_" ? "" : t;
}

/** Target ids that exist (docs/data/challenge.json, checked out next to the scripts). */
function challengeTargets() {
  try {
    const path = require("path").join(process.env.GITHUB_WORKSPACE || ".", "docs/data/challenge.json");
    return JSON.parse(require("fs").readFileSync(path, "utf8")).targets.map(t => t.id);
  } catch (e) { return null; }
}
/** The targets' own patterns {id: 105 digits}: an entry may not simply copy one. */
function targetPatterns() {
  try {
    const path = require("path").join(process.env.GITHUB_WORKSPACE || ".", "docs/data/challenge.json");
    return Object.fromEntries(JSON.parse(require("fs").readFileSync(path, "utf8")).targets.filter(t => t.pattern).map(t => [t.id, t.pattern]));
  } catch (e) { return {}; }
}

function consentGiven(body) {
  return /-\s*\[[xX]\]\s*I agree/.test(body || "");
}

/** Text drawing of the specimen, top row first (code lists the bottom row first). */
function render(code) {
  const rows = [];
  let p = 0;
  for (let r = 18; r >= 0; r--) {
    const n = r % 2 === 0 ? 6 : 5;
    const cells = code.slice(p, p + n).split("").map(b => (b === "1" ? "■" : "□"));
    p += n;
    rows[r] = (n === 5 ? " " : "") + cells.join(" ");
  }
  return rows.join("\n");
}

async function ensureLabels(github, owner, repo) {
  for (const [name, [color, description]] of Object.entries(LABELS)) {
    try { await github.rest.issues.createLabel({ owner, repo, name, color, description }); }
    catch (e) { if (e.status !== 422) throw e; }      // 422 = already exists
  }
}

async function upsertComment(github, owner, repo, number, text) {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const mine = comments.find(c => c.body && c.body.includes(MARK));
  const body = `${MARK}\n${text}`;
  if (mine) {
    if (mine.body !== body) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }
}

async function setLabels(github, owner, repo, issue, add, remove) {
  const have = new Set(issue.labels.map(l => (typeof l === "string" ? l : l.name)));
  for (const name of remove) if (have.has(name)) {
    try { await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name }); } catch (e) { if (e.status !== 404) throw e; }
  }
  const toAdd = add.filter(n => !have.has(n));
  if (toAdd.length) await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: toAdd });
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  // Read the request as it is NOW: a form request fires two events (opened + labeled), and by the second
  // run the rig may already have started it; the event's copy of the labels would be out of date.
  let issue = context.payload.issue;
  try { issue = (await github.rest.issues.get({ owner, repo, issue_number: issue.number })).data; } catch (e) { /* use the event copy */ }
  const labels = new Set(issue.labels.map(l => l.name));
  if (!labels.has("pattern-request")) { core.info("Not a pattern request; nothing to do."); return; }
  if (issue.state !== "open") { core.info("Issue is closed; nothing to do."); return; }
  if (labels.has("running") || labels.has("done") || labels.has("failed")) {
    core.info("Already started; edits after this point are ignored."); return;
  }
  await ensureLabels(github, owner, repo);

  const formName = section(issue.body, "your name").replace(/\s+/g, " ").trim();
  const blocked = blockedUsers();
  if (blocked.includes(issue.user.login.toLowerCase()) || (formName && blocked.includes(formName.toLowerCase()))) {
    await setLabels(github, owner, repo, issue, ["invalid"], ["queued", "awaiting-approval"]);
    await upsertComment(github, owner, repo, issue.number, "**This account can't submit requests to the rig.** If you think this is a mistake, contact the lab.");
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: "closed", state_reason: "not_planned" });
    return;
  }

  const maxPerUser = parseInt(process.env.MAX_OPEN_PER_USER || "3", 10);
  const needApproval = String(process.env.REQUIRE_APPROVAL || "false").toLowerCase() === "true";
  const fail = async why => {
    await setLabels(github, owner, repo, issue, ["invalid"], ["queued", "awaiting-approval"]);
    await upsertComment(github, owner, repo, issue.number,
      `**This ${labels.has("batch-request") && labels.has("challenge") ? "set of challenge entries" : labels.has("batch-request") ? "batch" : "pattern"} can't be queued yet.** ${why}\n\nEdit the request to fix it (the ⋯ menu → Edit); it is checked again automatically.`);
  };

  const isBatch = labels.has("batch-request");
  const isChallengeBatch = isBatch && labels.has("challenge");
  const parsed = isChallengeBatch ? parseChallengeEntries(issue.body) : isBatch ? parseBatch(issue.body) : parsePattern(issue.body);
  if (!parsed.ok) return fail(parsed.why);
  const name = section(issue.body, "your name").replace(/\s+/g, " ").trim();
  if (!name) return fail("Enter your name in the **Your name** field, so everyone can see whose patterns are being tested.");
  if (name.length > 80) return fail("Shorten the name in the **Your name** field to at most 80 characters.");
  if (!consentGiven(issue.body)) return fail("Tick the data-sharing box so the results can be published.");
  const isChallenge = labels.has("challenge");
  let target = "";
  if (isChallengeBatch) {
    const ids = challengeTargets();
    const bad = ids ? parsed.entries.map(e => e.target).filter(t => !ids.includes(t)) : [];
    if (bad.length) return fail(`There is no target ${bad.join(", ")}. The targets are ${ids.join(", ")}.`);
    const own = targetPatterns(), copies = parsed.entries.filter(e => own[e.target] && own[e.target] === e.code).map(e => e.target);
    if (copies.length) return fail(`The entry for ${copies.join(", ")} is the target's own pattern. The challenge is to find a different pattern with the same curve.`);
    if (section(issue.body, "method").replace(/\s+/g, " ").length < 20)
      return fail("Describe your method in the Method field (at least 20 characters). It is shown on the leaderboard.");
  } else if (isChallenge) {
    target = (section(issue.body, "target").match(/T\d+/i) || [""])[0].toUpperCase();
    const ids = challengeTargets();
    if (!target) return fail("Enter the challenge target (T1 to T10) in the Target field.");
    if (ids && !ids.includes(target)) return fail(`There is no target ${target}. The targets are ${ids.join(", ")}.`);
    if (targetPatterns()[target] && targetPatterns()[target] === parsed.code) return fail(`This is target ${target}'s own pattern. The challenge is to find a different pattern with the same curve.`);
    if (section(issue.body, "method").replace(/\s+/g, " ").length < 20)
      return fail("Describe your method in the Method field (at least 20 characters). It is shown on the leaderboard.");
  }

  // limit how many requests one person can have waiting. Requests sent from the website without a GitHub
  // account are all opened by the lab's key, so people are told apart by the name they entered.
  // listed without GitHub's label filter (it sometimes returns nothing) and filtered here
  const allOpen = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", per_page: 100 });
  const open = allOpen.filter(i => i.labels.some(l => (l.name || l) === "pattern-request"));
  const sameName = i => section(i.body, "your name").replace(/\s+/g, " ").trim().toLowerCase() === name.toLowerCase();
  const waiting = open.filter(i => i.number !== issue.number && i.labels.some(l => ["queued", "awaiting-approval", "running"].includes(l.name)) &&
    (i.user.login === issue.user.login && !viaWebsite(i) && !viaWebsite(issue) || sameName(i)));
  if (waiting.length >= maxPerUser)
    return fail(`You already have ${waiting.length} requests waiting (the limit is ${maxPerUser}). Edit this request after one of them has run and it is checked again, or send it again later.`);

  const queue = allOpen.filter(i => i.labels.some(l => (l.name || l) === "queued"));
  const ahead = queue.filter(i => i.number !== issue.number && new Date(i.created_at) < new Date(issue.created_at)).length;
  const where = needApproval
    ? "A lab member approves requests before they join the queue; you'll see the label change to **queued**."
    : `It is in the queue with ${ahead} request${ahead === 1 ? "" : "s"} ahead of it. It runs automatically when the machine is online.`;
  await setLabels(github, owner, repo, issue, [needApproval ? "awaiting-approval" : "queued"], ["invalid"]);
  if (isChallengeBatch) {
    const n = parsed.entries.length;
    const list = parsed.entries.map(e => `${e.target.padEnd(4)} ${e.code}  ${e.code.split("").filter(b => b === "1").length} inserts`).join("\n");
    await upsertComment(github, owner, repo, issue.number,
      `**Challenge entries accepted: ${n} pattern${n === 1 ? "" : "s"} for ${parsed.entries.map(e => e.target).join(", ")}.** ${where} ` +
      "They are tested one after another; each is scored against its target and added to the leaderboard. A summary with the scores is posted here when all are done." +
      `\n\n<details><summary>The ${n} entries (target, 105-digit code, inserts)</summary>\n\n` + "```\n" + list + "\n```\n</details>");
    return;
  }
  if (isBatch) {
    const n = parsed.codes.length;
    const list = parsed.codes.map((c, k) => `${String(k).padStart(3)}  ${c}  ${c.split("").filter(b => b === "1").length} inserts`).join("\n");
    await upsertComment(github, owner, repo, issue.number,
      `**Batch accepted: ${n} pattern${n === 1 ? "" : "s"}.** ${where} The patterns are tested one after another in the order they were listed; ` +
      `the results are posted here when the batch is finished.\n\n<details><summary>The ${n} patterns (index, 105-digit code, inserts)</summary>\n\n` +
      "```\n" + list + "\n```\n</details>");
    return;
  }
  const ones = parsed.code.split("").filter(b => b === "1").length;
  await upsertComment(github, owner, repo, issue.number,
    `**${isChallenge ? `Challenge entry for ${target} accepted` : "Pattern accepted"}: ${ones} inserts, ${105 - ones} empty cells.** ${where}` +
    (isChallenge ? " When it has been tested, its score against the target is posted here and on the leaderboard." : "") + "\n\n" +
    "```\n" + render(parsed.code) + "\n```\n" +
    "■ insert, □ empty, top row first. The results will be posted here when the test is done.");
}

module.exports = { run, parseChallengeEntries, section, challengeTargets, parsePattern, parseBatch, consentGiven, render, LABELS, MAX_BATCH };
