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
  "machine-status": ["8A96A0", "Live status of the rig (updated by the lab computer)"]
};

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
  const issue = context.payload.issue;
  const labels = new Set(issue.labels.map(l => l.name));
  if (!labels.has("pattern-request")) { core.info("Not a pattern request; nothing to do."); return; }
  if (issue.state !== "open") { core.info("Issue is closed; nothing to do."); return; }
  if (labels.has("running") || labels.has("done") || labels.has("failed")) {
    core.info("Already started; edits after this point are ignored."); return;
  }
  await ensureLabels(github, owner, repo);

  const maxPerUser = parseInt(process.env.MAX_OPEN_PER_USER || "3", 10);
  const needApproval = String(process.env.REQUIRE_APPROVAL || "false").toLowerCase() === "true";
  const fail = async why => {
    await setLabels(github, owner, repo, issue, ["invalid"], ["queued", "awaiting-approval"]);
    await upsertComment(github, owner, repo, issue.number,
      `**This ${labels.has("batch-request") ? "batch" : "pattern"} can't be queued yet.** ${why}\n\nEdit the request to fix it (the ⋯ menu → Edit); it is checked again automatically.`);
  };

  const isBatch = labels.has("batch-request");
  const parsed = isBatch ? parseBatch(issue.body) : parsePattern(issue.body);
  if (!parsed.ok) return fail(parsed.why);
  if (!consentGiven(issue.body)) return fail("Tick the data-sharing box so the results can be published.");
  const isChallenge = labels.has("challenge");
  let target = "";
  if (isChallenge) {
    target = (section(issue.body, "target").match(/T\d+/i) || [""])[0].toUpperCase();
    const ids = challengeTargets();
    if (!target) return fail("Enter the challenge target (T1 to T10) in the Target field.");
    if (ids && !ids.includes(target)) return fail(`There is no target ${target}. The targets are ${ids.join(", ")}.`);
    if (section(issue.body, "method").replace(/\s+/g, " ").length < 20)
      return fail("Describe your method in the Method field (at least 20 characters). It is shown on the leaderboard.");
  }

  // limit how many patterns one person can have waiting
  const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", creator: issue.user.login, per_page: 100 });
  const waiting = open.filter(i => i.number !== issue.number && i.labels.some(l => ["queued", "awaiting-approval", "running"].includes(l.name)));
  if (waiting.length >= maxPerUser)
    return fail(`You already have ${waiting.length} patterns waiting (the limit is ${maxPerUser}). Edit this request after one of them has run and it is checked again.`);

  const queue = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", labels: "queued", per_page: 100 });
  const ahead = queue.filter(i => i.number !== issue.number && new Date(i.created_at) < new Date(issue.created_at)).length;
  const where = needApproval
    ? "A lab member approves requests before they join the queue; you'll see the label change to **queued**."
    : `It is in the queue with ${ahead} request${ahead === 1 ? "" : "s"} ahead of it. It runs automatically when the machine is online.`;
  await setLabels(github, owner, repo, issue, [needApproval ? "awaiting-approval" : "queued"], ["invalid"]);
  if (isBatch) {
    const n = parsed.codes.length;
    const list = parsed.codes.map((c, k) => `${String(k).padStart(3)}  ${c}  ${c.split("").filter(b => b === "1").length} inserts`).join("\n");
    await upsertComment(github, owner, repo, issue.number,
      `**Batch accepted: ${n} pattern${n === 1 ? "" : "s"}.** ${where} The patterns are tested one after another in index order; ` +
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

module.exports = { run, section, challengeTargets, parsePattern, parseBatch, consentGiven, render, LABELS, MAX_BATCH };
