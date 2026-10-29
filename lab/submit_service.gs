/**
 * Sign-in-free submitting for the metamaterial rig website (Google Apps Script web app).
 *
 * The website sends a pattern (or a batch, or challenge entries) here; this script checks it and
 * opens the request on GitHub with the lab's key, in exactly the format of the GitHub request forms,
 * so the checker, the queue and the lab agent work as before. Visitors need no account.
 *
 * Setup (once): paste this file into a new project on script.google.com, add the Script property
 * GITHUB_TOKEN (Project settings -> Script properties) with a fine-grained token that has
 * Issues: Read and write on the rig repository only, then Deploy -> New deployment -> Web app,
 * Execute as: Me, Who has access: Anyone. Put the web-app URL in docs/assets/config.js (submitUrl).
 */
var OWNER = "adamslab-gibert";
var REPO = "metamaterial-rig";
var N_CELLS = 105;
var MAX_BATCH = 100;               // patterns per batch
var MAX_ENTRIES = 10;              // challenge entries per request
var PER_NAME_PER_HOUR = 5;         // requests one name may send per hour
var ALL_PER_HOUR = 60;             // requests everybody together may send per hour
var CONSENT = "I agree that the measured data, photos and this request are published openly under CC BY 4.0.";

function doGet() {
  return json_({ ok: true, service: "metamaterial rig submissions" });
}

function doPost(e) {
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (d.website) return json_({ ok: false, error: "Rejected." });          // hidden field: only bots fill it in
    var req = build_(d);
    if (req.error) return json_({ ok: false, error: req.error });
    var limit = rateLimit_(req.name);
    if (limit) return json_({ ok: false, error: limit });
    var issue = github_("post", "/issues", { title: req.title, body: req.body, labels: req.labels });
    return json_({ ok: true, number: issue.number, url: issue.html_url });
  } catch (err) {
    return json_({ ok: false, error: "The request could not be sent (" + String(err.message || err).slice(0, 200) + "). Please try again later." });
  }
}

/** Check the submission and turn it into a GitHub request in the issue-form format. */
function build_(d) {
  var name = String(d.name || "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Enter your name." };
  if (name.length > 80) return { error: "Use at most 80 characters for your name." };
  if (d.consent !== true) return { error: "Agree to publishing the data to submit." };
  var purpose = String(d.purpose || "").trim().slice(0, 1000) || "_No response_";
  var method = String(d.method || "").trim().slice(0, 1500);
  var sec = function (label, text) { return "### " + label + "\n\n" + text + "\n\n"; };
  var consent = sec("Data sharing", "- [X] " + CONSENT);
  var inserts = function (c) { return c.split("").filter(function (x) { return x === "1"; }).length; };

  if (d.kind === "pattern" || d.kind === "challenge") {
    var code = cleanCode_(d.pattern);
    if (!code) return { error: "The pattern needs 105 digits of 0 and 1." };
    if (d.kind === "pattern") {
      return { name: name, labels: ["pattern-request"], title: "Pattern request: " + inserts(code) + " inserts (" + name + ")",
        body: sec("Your name", name) + sec("Pattern (105 digits, 1 = insert)", code) + sec("What is the pattern for? (optional)", purpose) + consent };
    }
    var target = String(d.target || "").toUpperCase();
    if (!/^T\d{1,2}$/.test(target)) return { error: "Choose a challenge target (T1 to T10)." };
    if (method.replace(/\s+/g, " ").length < 20) return { error: "Describe your method (at least 20 characters)." };
    return { name: name, labels: ["pattern-request", "challenge"], title: "Challenge " + target + ": " + inserts(code) + " inserts (" + name + ")",
      body: sec("Your name", name) + sec("Target", target) + sec("Pattern (105 digits, 1 = insert)", code) + sec("Method", method) + consent };
  }
  if (d.kind === "batch") {
    var list = (d.patterns || []).map(cleanCode_);
    if (!list.length) return { error: "The batch has no patterns." };
    if (list.length > MAX_BATCH) return { error: "At most " + MAX_BATCH + " patterns per batch." };
    for (var k = 0; k < list.length; k++) if (!list[k]) return { error: "Pattern " + k + " is not valid (105 digits of 0 and 1)." };
    return { name: name, labels: ["pattern-request", "batch-request"], title: "Batch request: " + list.length + " pattern" + (list.length === 1 ? "" : "s") + " (" + name + ")",
      body: sec("Your name", name) + sec("Patterns (one per line, in index order)", "```\n" + list.join("\n") + "\n```") + sec("What are the patterns for? (optional)", purpose) + consent };
  }
  if (d.kind === "challenge_batch") {
    var entries = d.entries || [], seen = {}, lines = [];
    if (!entries.length) return { error: "There are no entries." };
    if (entries.length > MAX_ENTRIES) return { error: "At most " + MAX_ENTRIES + " entries (one per target)." };
    for (var j = 0; j < entries.length; j++) {
      var t = String(entries[j].target || "").toUpperCase(), c = cleanCode_(entries[j].pattern);
      if (!/^T\d{1,2}$/.test(t) || !c) return { error: "Entry " + (j + 1) + " is not valid." };
      if (seen[t]) return { error: "Target " + t + " appears more than once." };
      seen[t] = true; lines.push(t + " " + c);
    }
    if (method.replace(/\s+/g, " ").length < 20) return { error: "Describe your method (at least 20 characters)." };
    return { name: name, labels: ["pattern-request", "batch-request", "challenge"],
      title: "Challenge entries: " + Object.keys(seen).join(", ") + " (" + name + ")",
      body: sec("Your name", name) + sec("Entries (one per line, target then pattern)", "```\n" + lines.join("\n") + "\n```") + sec("Method", method) + consent };
  }
  return { error: "Unknown kind of request." };
}

function cleanCode_(p) {
  var s = String(p || "").replace(/[\s,]/g, "");
  return /^[01]{105}$/.test(s) ? s : null;
}

/** At most PER_NAME_PER_HOUR requests per name and ALL_PER_HOUR in total per hour. */
function rateLimit_(name) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cache = CacheService.getScriptCache(), hour = Utilities.formatDate(new Date(), "UTC", "yyyyMMddHH");
    var kAll = "all-" + hour, kName = "n-" + hour + "-" + name.toLowerCase().slice(0, 80);
    var all = Number(cache.get(kAll) || 0), mine = Number(cache.get(kName) || 0);
    if (all >= ALL_PER_HOUR) return "Many requests were sent in the last hour. Please try again later.";
    if (mine >= PER_NAME_PER_HOUR) return "You have sent " + mine + " requests in the last hour. Please try again later.";
    cache.put(kAll, String(all + 1), 3600);
    cache.put(kName, String(mine + 1), 3600);
    return "";
  } finally {
    lock.releaseLock();
  }
}

function github_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("the GitHub key is not set up");
  var r = UrlFetchApp.fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + path, {
    method: method, contentType: "application/json", payload: payload ? JSON.stringify(payload) : undefined,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    muteHttpExceptions: true
  });
  var code = r.getResponseCode();
  if (code >= 300) throw new Error("GitHub answered " + code);
  return JSON.parse(r.getContentText());
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor (select testSetup, click Run) to check the key without creating a request. */
function testSetup() {
  var repo = github_("get", "");
  Logger.log("OK: the key can reach " + repo.full_name);
}
