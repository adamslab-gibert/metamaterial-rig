/* Admin login (the "Admin" tab on every page).

   How the admin login works (nothing secret is stored on this public site):
   - assets/admin_key.json holds a GitHub token ENCRYPTED with the admin password
     (PBKDF2-SHA256, 600 000 rounds -> AES-GCM 256). The password itself is not stored anywhere.
   - Logging in = decrypting that file in the browser. Only the right password decrypts it.
   - The decrypted token stays in this browser tab only (sessionStorage) until "Log out" or the tab closes.
   - What the admin can do is limited by that token: Issues + Contents on this one repository. */
(function () {
  "use strict";
  const KEY_URL = "assets/admin_key.json";
  const ITER = 600000;
  const TOKEN_KEY = "rig-admin-token";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  function store(kind) { try { const s = window[kind]; s.setItem("_t", "1"); s.removeItem("_t"); return s; } catch (e) { return null; } }
  const session = store("sessionStorage");
  let memToken = null;

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptToken(token, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token));
    return { v: 1, kdf: "PBKDF2-SHA256", iterations: ITER, cipher: "AES-GCM-256", salt: b64(salt), iv: b64(iv), data: b64(ct),
      note: "Admin login for the rig website. Encrypted with the admin password, which is not stored anywhere." };
  }
  async function loadKeyFile() {
    const r = await fetch(KEY_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("The admin key could not be loaded (" + r.status + ").");
    return r.json();
  }
  /** Returns the token, or throws Error("wrong") / Error("missing"). */
  async function unlock(password) {
    const f = await loadKeyFile();
    if (!f) throw new Error("missing");
    try {
      const key = await deriveKey(password, unb64(f.salt));
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.iv) }, key, unb64(f.data));
      const token = dec.decode(pt);
      setToken(token);
      return token;
    } catch (e) { throw new Error("wrong"); }
  }
  function setToken(t) { memToken = t; if (session) session.setItem(TOKEN_KEY, t); }
  function token() { return memToken || (session && session.getItem(TOKEN_KEY)) || null; }
  function logout() { memToken = null; if (session) session.removeItem(TOKEN_KEY); }

  // ------------------------------------------------------------ the Admin tab
  // Every page shows the full site plus an "Admin" tab. The Admin page asks for the password; "Log out"
  // there returns this browser to the normal (guest) view. While logged in, the tab is marked.
  function init() {
    const tab = document.querySelector('.site-nav a[href^="admin.html"]');
    if (tab && token()) { tab.classList.add("logged-in"); tab.title = "Logged in as admin"; }
  }
  window.RigAdminAuth = { unlock, token, setToken, logout, encryptToken, loadKeyFile, ITER };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
