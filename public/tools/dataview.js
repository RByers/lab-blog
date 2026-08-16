/* dataview.js — the machinery behind the data tool in this folder.
 *
 * The tool is one shape repeated: point it at the MolBioLab data folder, get a
 * set of tabs, each a sortable / filterable / column-hideable table over one of
 * the CSVs. This file is all of that — reading the folder (and watching it),
 * remembering what you had open, drawing the table, the filter and column
 * menus, the legend, the address bar, the landing card. A group (inventory.js,
 * results.js) supplies only what is specific to it: which columns exist, how
 * rows are coloured, and whatever derived tabs it wants.
 *
 * The tabs come in blocks — Inventory and Results — one per group, assembled by
 * data.js. Tab ids are unique across the whole tool (`inv-samples`,
 * `res-results`), because they are what the address bar names and what one
 * tab's links point at, and a link crosses a block boundary as freely as it
 * stays inside one.
 *
 * Loaded as a classic script rather than a module on purpose: these pages are
 * meant to still work when opened straight off disk as file://, where module
 * loading is blocked by CORS but <script src> is not.
 */
"use strict";

const Dataview = (() => {

/* ============================ small helpers ============================ */
const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ============================ CSV ============================ */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

// A CSV as { cols, rows }, rows being plain objects keyed by header name.
function toObjects(text) {
  const rows = parseCSV(text || "");
  if (!rows.length) return { cols: [], rows: [] };
  const cols = rows[0].map(h => h.trim());
  return {
    cols,
    rows: rows.slice(1).map(r =>
      Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? "").trim()]))),
  };
}

/* ============================ value helpers ============================ */
// The repo writes dates as M/D/YYYY with an optional h:mm AM/PM.
function dnum(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*([AP])M)?/i);
  if (!m) return null;
  let [, mo, d, y, h, mi, ap] = m;
  y = +y; if (y < 100) y += 2000;
  h = h ? +h % 12 + (/p/i.test(ap) ? 12 : 0) : 0;
  return Date.UTC(y, mo - 1, d, h, +(mi || 0));
}
const dateOnly = v => String(v || "").split(/\s+/)[0];
const yearOf = v => { const t = dnum(v); return t === null ? 0 : new Date(t).getUTCFullYear(); };

// label sort: S9 < S10, and S47 < S47b
function labelKey(v) {
  const m = String(v).match(/^([A-Za-z]*)(\d+)(.*)$/);
  return m ? [m[1], +m[2], m[3]] : [String(v), 0, ""];
}
const cmpLabel = (a, b) => {
  const [ap, an, as] = labelKey(a), [bp, bn, bs] = labelKey(b);
  return ap.localeCompare(bp) || an - bn || as.localeCompare(bs);
};
const cmpText = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const cmpNum = (a, b) => (parseFloat(a) || -Infinity) - (parseFloat(b) || -Infinity);
const cmpDate = (a, b) => (dnum(a) ?? -Infinity) - (dnum(b) ?? -Infinity);

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 1) => v === null || v === undefined ? "" : String(+v.toFixed(d));

/* ======================= column types =======================
   `t` on a column definition says how the cell is drawn and how the column
   sorts. `cmp` is also what the filter menu orders its values by. */
const T = {
  txt:    {},
  num:    { cls: "num", cmp: cmpNum },
  date:   { cls: "nowrap", cmp: cmpDate },
  label:  { cls: "nowrap", cmp: cmpLabel },
  flag:   { cls: "nowrap" },
  clip:   { cls: "clip" },
  narrow: { cls: "clip narrow" },
  seq:    { cls: "mono clip", style: "max-width:18rem" },
  url:    { cls: "clip", url: true },
  badge:  { cls: "nowrap", badge: true },
  tick:   { cls: "nowrap", tick: true },
};

/* ======================= species → colour =======================
   Shared vocabulary rather than table machinery: both tools colour a row by
   the organism it is about, and they have to agree on which colour that is.

   An entry is [pattern, hue] for a virus, or [pattern, hue, chroma×,
   Δlightness] for a bacterium or fungus. Lightness and chroma otherwise come
   from CSS so the tints follow the theme; the two extra numbers are *relative*
   adjustments to those, which is what keeps the bacteria looking the same next
   to a light row, a dark row and the darker "hi" variant of either.

   Viruses take saturated hues from right around the wheel. Bacteria and fungi
   are confined to a warm 40–100 band with the chroma pulled down and the
   lightness dropped, which is what turns a would-be yellow or orange into tan
   and brown — so kingdom is legible from the row colour alone, before reading
   the label. Entry length is therefore also the kingdom test (see isWarm). */
const TINTS = [
  [/^HRV-A/i, 155], [/^HRV-B/i, 180], [/^HRV-C/i, 138], [/^(HRV|RV)$/i, 147], [/^ENT|^EV/i, 166],
  [/^SARS|^SC2|COV-?2/i, 27],
  [/^INFA|^FLUA|^IAV/i, 95], [/^INFB|^FLUB|^IBV/i, 78], [/^INF|^FLU/i, 88],
  // RSV subgroups A and B are one species; the subgroup is a pathogens.csv
  // Type, not a Species, so RSVA/RSVB are no longer values this has to match
  [/^RSV/i, 45],
  [/^OC43/i, 320], [/^HKU1/i, 311], [/^NL63/i, 329], [/^229E/i, 303], [/CORONA/i, 320],
  [/^H?PIV1/i, 254], [/^H?PIV2/i, 246], [/^H?PIV3/i, 262], [/^H?PIV4/i, 271],
  [/^PIV|^HPIV/i, 262], [/^MPV|^HMPV/i, 235],
  [/^ADV|ADENO/i, 207], [/^VZV|^HSV|HERPES/i, 300], [/^HBOV|BOCA/i, 288],
  // Bacteria and fungi, from the YouSeq panel. Specific patterns first: several
  // unrelated organisms are "…pneumo…", so a loose /PNEUMO/ would swallow them.
  // Within the band, hue separates the genera and lightness separates species
  // that share one, so H. influenzae and M. catarrhalis stay tellable apart.
  [/^H\.?\s?influenzae|^HFLU|^HAEM/i, 70, 0.85, -0.02],
  [/^S\.?\s?pneum/i,                  55, 0.70, -0.05],
  [/^S\.?\s?aureus|^STAPH/i,          85, 0.60, -0.03],
  [/^S\.?\s?pyog|^GAS$/i,             45, 0.80, -0.06],
  [/^M\.?\s?catar|^MORAX/i,           95, 0.55, -0.05],
  [/^K\.?\s?pneum|^KLEBS/i,           62, 0.55, -0.07],
  [/^A\.?\s?bauma|^ACINET/i,          78, 0.70, -0.06],
  [/^B\.?\s?pertu/i,                  50, 0.60, -0.02],
  [/^B\.?\s?parap/i,                  40, 0.55, -0.04],
  [/^P\.?\s?aerug|^PSEUD/i,          100, 0.70, -0.07],
  [/^L\.?\s?pneum|^LEGION/i,          88, 0.80, -0.07],
  [/^C\.?\s?pneum|^CHLAM/i,           66, 0.90, -0.04],
  [/^Mp?\.?\s?pneum|^MYCO/i,          75, 0.50, -0.08],
  [/^C\.?\s?albic|CANDIDA/i,          58, 0.85, -0.08],
  [/^STREP|^BORD|BACT/i,              60, 0.65, -0.04],
];

const tintEntry = s => TINTS.find(([re]) => re.test(s)) || null;
const hueOf = s => (tintEntry(s) || [, 0])[1];
const hasHue = s => !!tintEntry(s);
// bacteria and fungi are the entries carrying chroma/lightness adjustments
const isWarm = s => (tintEntry(s) || []).length > 2;

// The three custom properties a tint is expressed in. Rows, legend chips and
// legend swatches all read the same trio, so they can't drift apart.
function tint(s) {
  const t = tintEntry(s);
  return { h: t ? t[1] : 0, cm: t?.[2] ?? 1, ld: t?.[3] ?? 0 };
}
function paint(el, t) {
  if (typeof t === "string") t = tint(t);
  el.style.setProperty("--h", t.h);
  el.style.setProperty("--cm", t.cm ?? 1);
  el.style.setProperty("--ld", t.ld ?? 0);
}

/* A row about several organisms can't be coloured by picking one of them, so
   it gets 45° stripes cycling through a band per species instead. Built in JS
   because CSS has no loop over a variable number of stops, but each stop is
   written in terms of the same custom properties a flat row uses — so hover,
   dark mode and the "hi" tint keep working on a striped row without special
   cases. */
const band = ({ h, cm = 1, ld = 0 }) =>
  `oklch(calc(var(--tl) + var(--hov) + ${ld}) calc(var(--tc) * ${cm}) ${h})`;

function stripes(species) {
  const seen = new Set(), bands = [];
  for (const s of species) {
    if (!hasHue(s)) continue;                 // unknown organism adds no colour
    const t = tint(s), key = `${t.h}/${t.cm}/${t.ld}`;
    if (seen.has(key)) continue;              // two names, one tint: one band
    seen.add(key);
    bands.push(band(t));
  }
  if (bands.length < 2) return "";            // nothing to alternate between
  return `repeating-linear-gradient(45deg, ${bands.map((c, i) =>
    `${c} ${i ? `calc(${i} * var(--stripe))` : "0px"} calc(${i + 1} * var(--stripe))`
  ).join(", ")})`;
}

/* ===================== the data folder =====================
   Every tool reads the same folder, so they read the same file list and share
   the remembered directory handle: pick the folder in one and the other comes
   up already loaded. A tool names only the files it can't work without. */
const DATA_FILES = [
  "samples.csv", "pathogens.csv", "species.csv",
  "primers.csv", "reagents.csv", "assays.csv", "qPCR-results.csv",
  "cdna.csv", "sequencing.csv",
];

/* A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can hold
   it (localStorage can't — it's strings only). On the next visit the handle
   comes back and only its *permission* needs renewing, which is the small
   "let this site read files?" prompt rather than a fresh folder picker. */
const IDB = "molbiolab", IDB_STORE = "handles", IDB_KEY = "dir";
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(IDB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(val) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, IDB_KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
async function idbGet() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const rq = tx.objectStore(IDB_STORE).get(IDB_KEY);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}

/* ===================== GitHub as a source =====================
   The folder modes need a checkout; this one doesn't, so the tools work from a
   phone or a borrowed machine. Only api.github.com is involved, and it sends
   `access-control-allow-origin: *`, so no server is needed — but that is also
   why this is a pasted token rather than a "Login with GitHub" button:
   github.com/login/oauth/* sends no CORS headers at all, so the code-for-token
   exchange can't happen in a page. A fine-grained token scoped to the one repo
   with Contents: Read-only is a narrower grant than OAuth could give anyway
   (the OAuth `repo` scope is read *and write* to *every* private repo).

   Reads go through the git data API rather than the contents API: one request
   for `trees/HEAD:data` returns the tree's own sha — a version id for the whole
   folder — alongside every blob's sha, so a poll costs one request and says
   both *whether* anything changed and *which* files did. Blobs are then fetched
   by sha, which is content-addressed and so can't race a push mid-read.

   Like the directory handle, the token is shared by every tool here: paste it
   in one and the others come up already able to read. */
const GH_REPO = "RByers/MolBioLab";
const GH_DIR = "data";
/* Every CSV in that folder has a `.md` beside it saying what its columns mean
   and what the conventions in them are — the documentation this tool is a
   viewer for. The About link points at the one belonging to the current tab,
   on the canonical branch rather than on whatever the loaded data came from:
   the docs are the same wherever the folder was picked up from. */
const docsURL = file =>
  `https://github.com/${GH_REPO}/tree/main/${GH_DIR}/${file.replace(/\.csv$/, ".md")}`;
const GH_TOKEN_LS = "molbiolab.gh.token";
const GH_POLL_MS = 5_000;

function ghToken() {
  try { return localStorage.getItem(GH_TOKEN_LS) || ""; } catch { return ""; }
}
function ghSetToken(t) {
  try {
    if (t) localStorage.setItem(GH_TOKEN_LS, t);
    else localStorage.removeItem(GH_TOKEN_LS);
  } catch {}
}

/* A thrown message here goes straight to the user, so the statuses that mean
   different things to them are told apart: a token that isn't valid, a token
   that is valid but can't see this repo, and a rate limit. */
function ghErr(status, msg) {
  const e = new Error(msg);
  e.status = status;             // so callers can branch without reading prose
  return e;
}

async function ghApi(path, { raw = false, etag = "" } = {}) {
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${GH_REPO}/${path}`, {
      // Skip the HTTP cache so our own If-None-Match is what gets answered —
      // otherwise a cached 200 can stand in for the 304 we're looking for.
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${ghToken()}`,
        Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
  } catch {
    throw ghErr(0, "Couldn't reach GitHub — check the network connection.");
  }
  if (r.status === 401) {
    throw ghErr(401, "GitHub rejected that token (401) — it may be mistyped, expired, or revoked.");
  }
  if (r.status === 404) {
    throw ghErr(404, `Token can't see ${GH_REPO}/${GH_DIR} (404) — check it grants `
                   + "Contents: Read-only on that repository.");
  }
  if (r.status === 403 || r.status === 429) {
    throw ghErr(r.status, "GitHub is rate-limiting this token — try again in a few minutes.");
  }
  if (!r.ok && r.status !== 304) throw ghErr(r.status, `GitHub returned ${r.status}.`);
  return r;
}

/* The tree of the data folder: its version sha, every blob's sha, and the ETag
   that lets the next poll be free. Null when the ETag says nothing moved. */
async function ghTree({ etag = "" } = {}) {
  const r = await ghApi(`git/trees/HEAD:${GH_DIR}`, { etag });
  if (r.status === 304) return null;                 // nothing changed
  const j = await r.json();
  const shas = new Map();
  for (const e of j.tree || []) {
    if (e.type !== "blob") continue;
    const want = DATA_FILES.find(n => n.toLowerCase() === e.path.toLowerCase());
    if (want) shas.set(want, e.sha);
  }
  return { sha: j.sha, shas, etag: r.headers.get("ETag") || "" };
}

async function ghBlob(sha) {
  return (await ghApi(`git/blobs/${sha}`, { raw: true })).text();
}

function ghLabel(sha) { return `${GH_REPO.split("/")[1]}@${sha.slice(0, 7)}`; }

/* ===================== the address bar =====================
   The URL hash says which tab you're looking at and what it's filtered to, so a
   view can be linked to — from another tab, from the other block of tabs, or
   from outside the tool altogether:

     data.html#tab=inv-samples&Species=HRV-A
     data.html#tab=res-results&Sample=S90
     data.html#tab=inv-cdna&Tube=S183+cD

   `tab` and `q` (the search box) are reserved; every other parameter is a
   column name, repeated for several allowed values.

   It is deliberately an *address* rather than a mirror of every knob. The
   remembered preferences already carry the full UI state — sort, hidden
   columns, collapsed groups — and a filter set written out in full would put a
   hundred species names in the URL the moment you pressed a legend chip. So
   what the hash carries is the filter *intent*: the handful of values a link
   asked for, expanded against the loaded rows through the view's `match` (which
   is why `Sample=S90` also finds the pooled `S46+S53+S90` wells), and dropped
   again as soon as that column is filtered by hand, because it no longer
   describes what's on screen. */
const HASH_RESERVED = new Set(["tab", "q"]);

// "#" and "" are both "no address given", not "an address asking for nothing".
const hasAddr = () => location.hash.replace(/^#/, "").length > 0;

function parseHash(h = location.hash) {
  const p = new URLSearchParams(h.replace(/^#/, ""));
  const spec = {};
  for (const [k, v] of p) {
    if (HASH_RESERVED.has(k)) continue;
    (spec[k] ||= []).push(v);
  }
  return { tab: p.get("tab") || "", q: p.get("q") || "", spec };
}

function buildHash({ tab = "", q = "", spec = {} } = {}) {
  const p = new URLSearchParams();
  if (tab) p.set("tab", tab);
  for (const [k, vals] of Object.entries(spec)) for (const v of vals) p.append(k, v);
  if (q) p.set("q", q);
  const s = p.toString();
  return s ? "#" + s : "";
}

// An address as an href. Every tab lives on this one page, so an address is
// never anything but a hash.
const hrefFor = addr => buildHash(addr);

/* A cell that is also a way in to somewhere else. The click is stopped from
   bubbling because the clip-to-expand handler sits on the cell itself, and one
   click should do one thing. */
function link(text, addr, title) {
  const a = document.createElement("a");
  a.href = hrefFor(addr);
  a.textContent = text;
  if (title) a.title = title;
  a.addEventListener("click", e => e.stopPropagation());
  return a;
}

/* A link out of the repo, for a column whose text is the name of something
   that lives on the web. The scheme is checked rather than linked blind —
   href takes a javascript: URL just as happily as an http one, and this is
   CSV text. Returns the plain text when there's no usable URL. */
function extLink(text, url, title) {
  if (!/^https?:\/\//i.test(url || "")) return document.createTextNode(text);
  const a = document.createElement("a");
  a.href = url;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = title || url;
  a.addEventListener("click", e => e.stopPropagation());
  return a;
}

/* ============================ page chrome ============================
   Built here rather than written out in the HTML, which is then just the
   stylesheet, the scripts and a title — everything on the page depends on what
   the groups declare, so there is nothing static worth writing twice. */
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cg fill='none' stroke='%23262b31' stroke-width='2' stroke-linejoin='round'%3E%3Crect x='4' y='3' width='19' height='26' rx='2.5' fill='%23fbf9f2'/%3E%3Cpath d='M9.5 3v26'/%3E%3C/g%3E%3Cg stroke='%23a8b0b9' stroke-width='1.7' stroke-linecap='round'%3E%3Cpath d='M13 9.5h6'/%3E%3Cpath d='M13 13.5h6'/%3E%3C/g%3E%3Cpath d='M19.5 16.5v5L15.6 27.8A1.7 1.7 0 0 0 17 30.4h8.6a1.7 1.7 0 0 0 1.4-2.6L23.1 21.5v-5z' fill='%2334c26b' stroke='%23262b31' stroke-width='2' stroke-linejoin='round'/%3E%3Cpath d='M18 16.5h6.6' stroke='%23262b31' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E";

const FUNNEL_SVG = '<svg viewBox="0 0 12 12"><path d="M1.5 3h9M3 6h6M4.75 9h2.5"/></svg>';

/* One block per group: the group's name, then its tabs. The name is a button
   even when the block is open, because that is what it becomes when the window
   is too narrow to hold both blocks — see layoutTabs. */
function tabBlock(g, tabs) {
  return `<div class="tgrp" id="grp-${g.id}">
    <button class="gname" id="gbtn-${g.id}">${esc(g.label)}</button>
    <div class="tabset" id="set-${g.id}">${tabs.filter(t => t.group === g.id).map(t =>
      `<button role="tab" id="tab-${t.id}" aria-selected="false">${esc(t.label)}</button>`).join("")}</div>
  </div>`;
}

function buildChrome(cfg, tabs) {
  document.head.insertAdjacentHTML("beforeend",
    `<link rel="icon" href="${FAVICON}">`);
  document.body.insertAdjacentHTML("afterbegin", `
<header>
  <div class="row" id="topRow">
    <h1><a href="./" title="All lab tools">MolBioLab</a> ${esc(cfg.title)}
      <small id="src">no data</small><span id="live" hidden>updated</span></h1>
    <div class="tabs no-anim" role="tablist">${
      cfg.groups.map(g => tabBlock(g, tabs)).join("")}</div>
    <div class="spacer"></div>
    <span class="count" id="count"></span>
    <button class="btn" id="reloadBtn" title="Re-read the data">↻</button>
    <button class="btn" id="folderBtn" title="Change where the data comes from">Source…</button>
  </div>
  <div class="row" id="filterRow">
    <input class="search" id="q" type="search" placeholder="Search all columns…" autocomplete="off">
    <button class="btn" id="colsBtn" popovertarget="colsMenu" aria-expanded="false">Columns</button>
    <button class="btn" id="clearBtn" disabled>Clear filters</button>
    <a class="btn" id="aboutLink" target="_blank" rel="noopener noreferrer">About</a>
  </div>
</header>

<div class="notice hidden" id="notice"></div>
<div class="legend hidden" id="legend"></div>

<main class="scroll" id="tableWrap">
  <table><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table>
</main>

${tabs.filter(t => t.render).map(t =>
  `<section class="scroll stats hidden" id="pane-${t.id}"></section>`).join("")}

<section class="landing hidden" id="landing">
  <div class="card" id="card">
    <h2>Open your lab data folder</h2>
    <p>${cfg.landing}
       (The GitHub option below is the one exception — it talks to GitHub.)</p>
    <div class="row">
      <button class="btn primary hidden" id="reopen">Reopen</button>
      <button class="btn" id="pickDir">Choose folder…</button>
      <button class="btn" id="pickFiles">Choose files…</button>
    </div>
    <p class="hint" id="hint">…or drop the folder (or the CSVs) anywhere on this page.</p>

    <div class="alt">
      <h3>…or read them from GitHub</h3>
      <p>For a machine with no checkout. Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
         with repository access limited to <code>${esc(GH_REPO.split("/")[1])}</code> and the single
         permission <code>Contents: Read-only</code>, then paste it here.</p>
      <div class="row">
        <input class="tok" type="password" id="ghToken" autocomplete="off"
               spellcheck="false" placeholder="github_pat_…" aria-label="GitHub token">
        <button class="btn primary" id="ghLoad">Load from GitHub</button>
        <button class="btn hidden" id="ghForget">Forget token</button>
      </div>
      <p class="caveat">The token is kept in this browser's localStorage, where script on
         this origin can read it — so scope it to the one repo, read-only, and give it an expiry.</p>
    </div>

    <p class="err" id="err"></p>
  </div>
</section>

<div popover id="colsMenu"></div>
<div popover id="filterMenu"></div>
<input type="file" id="dirInput" webkitdirectory directory multiple class="hidden">
<input type="file" id="fileInput" accept=".csv" multiple class="hidden">`);
}

/* ============================ the app ============================ */
class App {
  constructor(cfg) {
    this.cfg = cfg;
    this.groups = cfg.groups;
    // The groups are separate only in the tab strip and in what builds them:
    // below this line there is one set of views, one set of rows and one
    // address space, and a link doesn't know or care which block it lands in.
    this.views = Object.assign({}, ...this.groups.map(g => g.views));
    this.names = Object.keys(this.views);
    // A data tab is a view onto exactly one of the CSVs, which is what lets it
    // say where its documentation is; a tab that would be a roll-up of several
    // files belongs in the group's computed `tabs` instead.
    for (const id of this.names)
      if (!this.views[id].file) throw new Error(`view ${id} names no data file`);
    // one block per group: its data views, then whatever computed tabs it adds
    this.tabs = this.groups.flatMap(g => [
      ...Object.keys(g.views).map(id => ({ id, group: g.id, label: g.views[id].label || id })),
      ...(g.tabs || []).map(t => ({ ...t, group: g.id })),
    ]);
    // a file any group can't work without is a file the tool can't work without
    this.required = [...new Set(this.groups.flatMap(g => g.required || []))];
    this.observer = null;
    this.watchTimer = 0;
    // The remote folder as of the last read: its ETag, its blob shas and the
    // texts, kept so a poll only has to refetch what actually moved.
    this.ghEtag = "";
    this.ghShas = new Map();
    this.ghTexts = {};
    this.ghTimer = 0;
    this.ghPolling = false;
    // An address read out of the hash before the CSVs arrived: its filters
    // can't be resolved against rows that don't exist yet, so it waits here
    // for the first ingest.
    this.pending = null;

    const state = this.state = {
      view: this.tabs[0].id,
      // the tab each block was last left on, so a collapsed block reopens where
      // you left it rather than back at its first tab
      lastTab: Object.fromEntries(this.groups.map(g =>
        [g.id, this.tabs.find(t => t.group === g.id).id])),
      label: "",             // the folder name shown in the header
      rows: {},              // view -> row objects
      q: "",
      filters: {},           // view -> col -> Set of allowed values
      spec: {},              // view -> col -> [values] — the addressable intent
      hidden: {},            // view -> Set of hidden column keys
      sort: {},              // view -> { k, dir }
      collapsed: {},         // view -> Set of collapsed group keys
      expanded: {},          // view -> Set of rows showing their detail
      source: "",            // "local" | "github" — which source is live
      dirHandle: null,
    };
    for (const v of this.names) {
      const def = this.views[v];
      state.rows[v] = [];
      state.filters[v] = {};
      state.spec[v] = {};
      state.collapsed[v] = new Set();
      state.expanded[v] = new Set();
      state.sort[v] = { ...(def.sort || { k: def.key, dir: 1 }) };
      state.hidden[v] = new Set(def.cols.filter(c => c.off).map(c => c.k));
    }
  }

  /* ---- lifecycle ---- */
  start() {
    Dataview.app = this;      // the live app, for poking at from the console
    buildChrome(this.cfg, this.tabs);
    this.loadPrefs();
    // A hash beats what was remembered: it is what the person following the
    // link asked for, and they asked for it more recently. No hash is not an
    // address, though — it's an ordinary visit, and it must leave the
    // remembered filters and search box alone.
    if (hasAddr()) this.readAddr(parseHash());
    this.wire();
    $("#q").value = this.state.q || "";
    if (window.FileSystemObserver) {
      $("#reloadBtn").title = "Re-read the data — though a picked folder "
        + "is watched, so edits normally appear on their own";
    }
    this.showLanding();
    // Lay the tabs out before the first paint, and only then let the strip
    // animate — a block that arrives already folded shouldn't fold on screen.
    // Widths measured this early can still be wrong (a web font arriving, a
    // scrollbar appearing), so the header is watched rather than measured once.
    this.layoutTabs();
    new ResizeObserver(() => this.layoutTabs()).observe($("#topRow"));
    requestAnimationFrame(() => $(".tabs").classList.remove("no-anim"));
    if (!window.showDirectoryPicker) this.noteFallback();
    this.syncGhButtons();
    $("#ghToken").value = ghToken();
    // Come back up on whichever source was last in use; if that doesn't produce
    // data the landing card is already showing, which is the right fallback.
    if (this.state.source === "github" && ghToken()) this.loadFromGitHub();
    else this.restoreDir();
  }

  /* ---- preferences ----
     Everything the user has adjusted is persisted, so a reload comes back to
     the same screen: which tab, sort per tab, hidden columns, column filters,
     collapsed groups and the search box. Sets serialize as arrays. */
  savePrefs() {
    const s = this.state;
    try {
      const hidden = {}, filters = {}, collapsed = {}, expanded = {};
      for (const v of this.names) {
        hidden[v] = [...s.hidden[v]];
        collapsed[v] = [...s.collapsed[v]];
        expanded[v] = [...s.expanded[v]];
        filters[v] = Object.fromEntries(
          Object.entries(s.filters[v]).map(([k, set]) => [k, [...set]]));
      }
      localStorage.setItem(this.cfg.prefsKey, JSON.stringify(
        { view: s.view, lastTab: s.lastTab, sort: s.sort, hidden, filters,
          collapsed, expanded, spec: s.spec, q: s.q, source: s.source }));
    } catch {}
  }

  loadPrefs() {
    const s = this.state;
    try {
      const p = JSON.parse(localStorage.getItem(this.cfg.prefsKey) || "null");
      if (!p) return;
      if (this.tabs.some(t => t.id === p.view)) s.view = p.view;
      for (const g of this.groups) {
        const t = p.lastTab?.[g.id];
        if (this.tabs.some(x => x.id === t && x.group === g.id)) s.lastTab[g.id] = t;
      }
      s.lastTab[this.groupOf(s.view)] = s.view;
      if (p.sort) for (const v of this.names) if (p.sort[v]) s.sort[v] = p.sort[v];
      if (p.hidden) for (const v of this.names)
        if (Array.isArray(p.hidden[v])) s.hidden[v] = new Set(p.hidden[v]);
      if (p.collapsed) for (const v of this.names)
        if (Array.isArray(p.collapsed[v])) s.collapsed[v] = new Set(p.collapsed[v]);
      if (p.expanded) for (const v of this.names)
        if (Array.isArray(p.expanded[v])) s.expanded[v] = new Set(p.expanded[v]);
      if (p.filters) for (const v of this.names) {
        const f = p.filters[v];
        if (!f || typeof f !== "object") continue;
        s.filters[v] = Object.fromEntries(
          Object.entries(f).filter(([, arr]) => Array.isArray(arr))
                .map(([k, arr]) => [k, new Set(arr)]));
      }
      // The intent behind those filters — what the address bar shows, and what
      // a pressed legend chip is read back out of. Only kept where the filter
      // it produced survived alongside it.
      if (p.spec) for (const v of this.names) {
        const f = p.spec[v];
        if (!f || typeof f !== "object") continue;
        s.spec[v] = Object.fromEntries(
          Object.entries(f).filter(([k, arr]) => Array.isArray(arr) && s.filters[v][k]));
      }
      if (typeof p.q === "string") s.q = p.q;
      // Only remembered so start() knows which source to try first; the source
      // itself is re-established from the handle or the token, not from here.
      if (p.source === "local" || p.source === "github") s.source = p.source;
    } catch {}
  }

  /* ---- the address bar ----
     readAddr takes what the hash says and puts it into the state; syncAddr
     writes the state back out. Only the tab and the search box can be applied
     straight away — a filter has to be resolved against rows, which on a cold
     load haven't been read yet, so it waits for the first ingest. */
  readAddr(addr) {
    const s = this.state;
    if (addr.tab && this.tabs.some(t => t.id === addr.tab)) s.view = addr.tab;
    s.q = addr.q;
    $("#q") && ($("#q").value = s.q);
    const v = s.view;
    if (!this.names.includes(v)) return;      // a computed tab has no filters
    if (!Object.keys(addr.spec).length) {
      // An address with no filters means an unfiltered tab, not "leave what
      // was there" — otherwise a link into a tab lands on someone's old filter.
      s.spec[v] = {}; s.filters[v] = {};
      return;
    }
    if (this.state.rows[v].length) this.applySpec(v, addr.spec, true);
    else this.pending = { view: v, spec: addr.spec };
  }

  /* Turn a filter intent into the concrete set of cell values that satisfies
     it. `match` is what lets one asked-for value cover several cells: a
     multi-species row, a pooled sample, an assay named for the design it was
     prepared from. */
  applySpec(v, spec, replace = false) {
    const def = this.views[v];
    // An address describes the whole view, so following one starts from a
    // clean slate; a legend chip is one column's worth of intent and leaves
    // the rest of the filters alone.
    const filters = replace ? {} : this.state.filters[v];
    const kept = replace ? {} : this.state.spec[v];
    for (const [k, wanted] of Object.entries(spec)) {
      if (!def.cols.some(c => c.k === k)) continue;   // not a column here
      const m = def.match?.[k] || ((cell, want) => cell === want);
      const set = new Set();
      for (const r of this.state.rows[v]) {
        const cell = r[k] ?? "";
        if (wanted.some(w => m(cell, w))) set.add(cell);
      }
      filters[k] = set;
      kept[k] = wanted;
    }
    this.state.filters[v] = filters;
    this.state.spec[v] = kept;
  }

  syncAddr() {
    const s = this.state, v = s.view;
    const addr = { tab: v, q: s.q, spec: this.names.includes(v) ? s.spec[v] : {} };
    // replaceState rather than assigning location.hash: this runs on every
    // render, and a history entry per keystroke in the search box would make
    // Back useless. Following a link is the case that *should* push, and that
    // is the browser's own doing.
    const url = buildHash(addr) || location.pathname + location.search;
    try { history.replaceState(history.state, "", url); } catch {}
  }

  // A column the user filtered by hand is no longer what the link asked for.
  unspec(v, k) {
    if (k === undefined) this.state.spec[v] = {};
    else delete this.state.spec[v][k];
  }

  /* Which legend chip is pressed is read back out of the intent, not out of
     the filter it produced: one row can name several species, so inferring it
     from the filter would light up every species named in a multi-value cell
     rather than the one that was clicked. */
  /* null, not "", when nothing is pressed: a chip's key can legitimately be
     the empty string — the reagents with no Category — and it has to be
     distinguishable from "no chip". */
  chipKey(v = this.state.view) {
    const col = this.views[v]?.chipCol, spec = this.state.spec[v];
    if (!col || !spec) return null;
    const keys = Object.keys(spec);
    return keys.length === 1 && keys[0] === col && spec[col].length === 1 ? spec[col][0] : null;
  }

  /* ---- messages ---- */
  err(m) { $("#err").textContent = m || ""; }

  // Post-load warnings. #err lives on the landing card, which is hidden once
  // data is showing, so anything the user needs to see after a successful load
  // goes in the notice bar instead.
  notice(m) {
    const el = $("#notice");
    el.replaceChildren();
    el.classList.toggle("hidden", !m);
    if (!m) return;
    el.insertAdjacentHTML("beforeend", `<span>⚠ ${esc(m)}</span>`);
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Dismiss";
    x.addEventListener("click", () => this.notice(""));
    el.append(x);
  }

  /* ===================== reading the folder ===================== */
  async readAll(base) {
    const texts = {};
    for (const n of DATA_FILES) {
      try { texts[n] = await (await (await base.getFileHandle(n)).getFile()).text(); } catch {}
    }
    const missing = this.required.filter(n => texts[n] === undefined);
    if (missing.length) {
      const e = new Error("That folder has no " + missing.join(" / ") + ".");
      e.name = "NotFoundError";
      throw e;
    }
    return texts;
  }

  async loadFromDirHandle(dir) {
    let base = dir;
    // allow picking either the repo root or the data/ folder
    const names = new Set();
    for await (const [n, h] of dir.entries()) if (h.kind === "file") names.add(n.toLowerCase());
    if (!this.required.every(n => names.has(n.toLowerCase()))) {
      try { base = await dir.getDirectoryHandle("data"); } catch { /* readAll reports it */ }
    }
    const texts = await this.readAll(base);
    this.ghUnwatch();                 // the two sources are mutually exclusive
    this.state.source = "local";
    this.state.dirHandle = base;
    this.savePrefs();
    // Remember the folder the user picked (not `base`) so a later reopen goes
    // through the same repo-root-or-data/ resolution.
    idbPut(dir);
    this.ingest(texts, dir.name + (base === dir ? "" : "/data"));
    this.watch(base);
  }

  loadFromFileList(files) {
    const picked = {}; let label = "";
    const wanted = new Map(DATA_FILES.map(n => [n.toLowerCase(), n]));
    for (const f of files) {
      const n = wanted.get(f.name.toLowerCase());
      if (n) { picked[n] = f; label = (f.webkitRelativePath || f.name).split("/")[0] || "files"; }
    }
    const missing = this.required.filter(n => !picked[n]);
    if (missing.length) {
      this.err("Couldn't find " + missing.join(" and ") + " in what you picked.");
      return Promise.resolve();
    }
    // a picked File is a snapshot with no handle behind it: nothing to watch
    this.unwatch();
    this.ghUnwatch();
    this.state.source = "local";
    this.state.dirHandle = null;
    this.savePrefs();
    const got = Object.keys(picked);
    return Promise.all(got.map(n => picked[n].text())).then(vals => {
      this.ingest(Object.fromEntries(got.map((n, i) => [n, vals[i]])), label);
    });
  }

  async pickDirectory() {
    this.err("");
    if (!window.showDirectoryPicker) { $("#dirInput").click(); return; }
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: "molbiolab", mode: "read" });
    } catch (e) {
      // AbortError = user cancelled. Anything else means the API isn't usable
      // here (notably: file:// pages have an opaque origin, which Chrome
      // refuses), so fall back to the classic folder-upload dialog.
      if (e.name !== "AbortError") { this.noteFallback(); $("#dirInput").click(); }
      return;
    }
    try {
      await this.loadFromDirHandle(dir);
    } catch (e) {
      this.err(e.name === "NotFoundError"
        ? e.message + " (looked in the folder itself and in its data/ subfolder)"
        : e.message);
    }
  }

  /* ===================== reading from GitHub =====================
     The remote counterpart of the folder modes: same files, fetched by sha.
     Only what the tree says we don't already hold is refetched, in parallel,
     so a poll that finds one changed CSV pays for one blob. */
  async ghReadAll(shas) {
    const texts = {};
    await Promise.all(DATA_FILES.filter(n => shas.has(n)).map(async n => {
      if (this.ghShas.get(n) === shas.get(n) && this.ghTexts[n] !== undefined) {
        texts[n] = this.ghTexts[n];
      } else {
        texts[n] = await ghBlob(shas.get(n));
      }
    }));
    const missing = this.required.filter(n => texts[n] === undefined);
    if (missing.length) {
      throw new Error(`${GH_REPO}/${GH_DIR} has no ` + missing.join(" / ") + ".");
    }
    return texts;
  }

  // Read the tree, fetch what moved, and adopt it as the current remote state.
  async ghFetch(tree) {
    const texts = await this.ghReadAll(tree.shas);
    this.ghTexts = texts;
    this.ghEtag = tree.etag;
    this.ghShas = tree.shas;
    return { texts, label: ghLabel(tree.sha) };
  }

  async loadFromGitHub() {
    if (!ghToken()) { this.err("Paste a GitHub token first."); return; }
    const btn = $("#ghLoad");
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const { texts, label } = await this.ghFetch(await ghTree());
      // a remote read has no folder behind it: stop watching one
      this.unwatch();
      this.state.dirHandle = null;
      this.state.source = "github";
      this.savePrefs();
      this.ingest(texts, label);
      this.ghWatch();
    } catch (e) {
      this.err(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  }

  /* The remote counterpart of the FileSystemObserver: poll the tree, but
     conditionally. A 304 doesn't count against the rate limit, so the steady
     state of this is free even at a few seconds apart — and while the tab is
     hidden it doesn't even do that. Coming back to the tool (focus, or the tab
     becoming visible) polls straight away, so the wait is only ever paid by a
     window you were already looking at. */
  ghWatch() {
    this.ghUnwatch();
    this.ghTimer = setInterval(() => { if (!document.hidden) this.ghPoll(); }, GH_POLL_MS);
  }

  ghUnwatch() {
    clearInterval(this.ghTimer);
    this.ghTimer = 0;
  }

  async ghPoll() {
    if (this.state.source !== "github" || !ghToken()) return;
    // At this cadence a slow tree read — or the blob fetches after one that
    // moved — can still be running when the next trigger arrives, and focus
    // and visibilitychange often arrive together. One at a time.
    if (this.ghPolling) return;
    this.ghPolling = true;
    try {
      let t;
      try {
        t = await ghTree({ etag: this.ghEtag });
      } catch (e) {
        // A revoked token or a rate limit would otherwise fail again every
        // tick: say so once and stop. A transient network blip waits for the
        // next one.
        if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 429) {
          this.ghUnwatch();
          this.notice(e.message);
        }
        return;
      }
      if (!t) return;                                // 304: nothing moved
      await this.refreshWith(() => this.ghFetch(t));
    } finally {
      this.ghPolling = false;
    }
  }

  // "Forget" is only meaningful once something is stored.
  syncGhButtons() {
    $("#ghForget").classList.toggle("hidden", !ghToken());
  }

  async reload() {
    if (this.state.source === "github") {
      try {
        const { texts, label } = await this.ghFetch(await ghTree());
        this.ingest(texts, label);
        return;
      } catch (e) { this.err(e.message); }
    } else if (this.state.dirHandle) {
      try {
        this.ingest(await this.readAll(this.state.dirHandle), this.state.label);
        return;
      } catch (e) { this.err(e.message); }
    }
    this.showLanding();
  }

  /* On startup, try the folder from last time. If the permission is still
     granted the page just comes back up with data; if it needs renewing we
     show a one-click Reopen, because requestPermission() must run from a user
     gesture — and that prompt is the small Chrome permission bubble, not the
     folder picker. */
  async restoreDir() {
    if (!window.showDirectoryPicker) return false;
    const dir = await idbGet();
    if (!dir) return false;
    try {
      if (await dir.queryPermission({ mode: "read" }) === "granted") {
        await this.loadFromDirHandle(dir);
        return true;
      }
    } catch { return false; }
    this.offerReopen(dir);
    return false;
  }

  offerReopen(dir) {
    const btn = $("#reopen");
    btn.textContent = `Reopen ${dir.name}`;
    btn.classList.remove("hidden");
    btn.onclick = async () => {
      try {
        if (await dir.requestPermission({ mode: "read" }) !== "granted") return;
        await this.loadFromDirHandle(dir);
      } catch (e) { this.err(e.message); }
    };
  }

  /* ===================== watching the folder =====================
     With a directory handle in hand the page can follow the files instead of
     waiting to be told: edit a CSV in a spreadsheet or an editor, and the
     table catches up on its own. FileSystemObserver isn't available
     everywhere, so this is strictly an enhancement — ↻ remains the manual
     path, and is the only path when the CSVs came from the file pickers (a
     File is a snapshot, with no handle to observe). */
  async watch(dir) {
    this.unwatch();
    if (!window.FileSystemObserver) return;
    try {
      this.observer = new FileSystemObserver(records => {
        // "errored" means the observation itself has stopped — usually the
        // folder went away — so drop it rather than sit on a dead observer.
        if (records.some(r => r.type === "errored")) { this.unwatch(); return; }
        // A record's path is relative to the observed root; an empty one is
        // the root itself. Ignore edits to files we don't read (the folder is
        // a whole repo when the CSVs live at its top level).
        const ours = records.some(r => {
          const name = r.relativePathComponents?.at(-1);
          return !name || DATA_FILES.some(f => f.toLowerCase() === name.toLowerCase());
        });
        if (!ours) return;
        // Saves arrive in bursts: an atomic save is a write to a temp file plus
        // a rename, and some editors touch a file more than once. Coalesce, and
        // let the burst settle so a half-written file isn't what gets parsed.
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.refresh(), 250);
      });
      await this.observer.observe(dir, { recursive: false });
    } catch { this.observer = null; }   // unsupported here; ↻ still works
  }

  unwatch() {
    clearTimeout(this.watchTimer);
    try { this.observer?.disconnect(); } catch {}
    this.observer = null;
  }

  /* Re-read after a change. Deliberately quieter than ↻: the scroll position
     is kept, and a failure is swallowed — reading mid-write throws or yields a
     truncated file, and the write that follows will bring us back. */
  async refreshWith(load) {          // load() -> { texts, label }
    const wrap = $("#tableWrap");
    const { scrollTop, scrollLeft } = wrap;
    try {
      const { texts, label } = await load();
      this.ingest(texts, label);
    } catch { return; }
    wrap.scrollTop = scrollTop;
    wrap.scrollLeft = scrollLeft;
    // A refresh nobody asked for needs to say it happened, or the numbers just
    // change while you're looking at them.
    const el = $("#live");
    el.hidden = false;
    el.classList.remove("go");
    void el.offsetWidth;        // restart the fade if changes land back to back
    el.classList.add("go");
  }

  async refresh() {
    if (!this.state.dirHandle) return;
    return this.refreshWith(async () => (
      { texts: await this.readAll(this.state.dirHandle), label: this.state.label }));
  }

  /* Hand the parsed CSVs to each group, which returns the rows for its own
     views. They read the same tables — the inventory colours a sample by what
     the results found in it, the results name the person a sample came from —
     so every group is handed all of them, and takes what it needs. */
  ingest(texts, label) {
    this.err("");
    const tables = {};
    for (const [name, text] of Object.entries(texts)) tables[name] = toObjects(text);
    const notices = [];
    for (const g of this.groups) {
      const { rows, notice } = g.ingest(tables, this);
      for (const v of Object.keys(g.views)) this.state.rows[v] = rows[v] || [];
      if (notice) notices.push(notice);
    }
    // Both blocks can have something to say about the same folder — the same
    // separator they use between their own notes keeps that one bar readable.
    const notice = notices.join("  ·  ");
    // The address that arrived before the data did, now that there are rows to
    // resolve it against.
    if (this.pending) {
      this.applySpec(this.pending.view, this.pending.spec, true);
      this.pending = null;
    }
    this.state.label = label;
    $("#src").textContent = label;
    $("#landing").classList.add("hidden");
    this.notice(notice || "");
    this.render();
  }

  showLanding() {
    this.unwatch();
    this.ghUnwatch();
    $("#landing").classList.remove("hidden");
    $("#tableWrap").classList.add("hidden");
    $("#legend").classList.add("hidden");
    for (const t of this.tabs) if (t.render) $("#pane-" + t.id).classList.add("hidden");
  }

  noteFallback() {
    $("#hint").innerHTML =
      "<b>Choose folder…</b> is using the classic folder dialog here (the File System Access API " +
      "isn’t available on <code>file://</code> pages), so ↻ can’t re-read from disk without re-picking. " +
      "Serving the folder over http — <code>python3 -m http.server</code> — gets you one-click reload.";
  }

  /* ============================ rows ============================ */
  view() { return this.views[this.state.view]; }
  visibleCols() {
    return this.view().cols.filter(c => !this.state.hidden[this.state.view].has(c.k));
  }
  // is the current view's grouping in effect? (a view can make it conditional
  // on the sort, the way the qPCR run grouping is)
  grouping(v = this.state.view) {
    const g = this.views[v].group;
    if (!g) return null;
    return !g.when || g.when(this.state.sort[v]) ? g : null;
  }

  activeRows() {
    const s = this.state, v = s.view, def = this.views[v];
    const f = s.filters[v], q = s.q.toLowerCase().trim();
    const cols = def.cols;
    let rows = s.rows[v].filter(r => {
      for (const k in f) { const set = f[k]; if (set && !set.has(r[k] ?? "")) return false; }
      if (!q) return true;
      return cols.some(c => String(r[c.k] ?? "").toLowerCase().includes(q));
    });

    const sort = s.sort[v];
    const custom = def.sortRows?.(rows, sort);
    if (custom) rows = custom;
    else {
      const col = cols.find(c => c.k === sort.k);
      if (col && sort.dir) {
        const cmp = col.t.cmp || cmpText;
        rows = rows.slice().sort((a, b) => {
          const r = cmp(a[sort.k] ?? "", b[sort.k] ?? "");
          return (r || cmpLabel(a[def.key], b[def.key])) * sort.dir;
        });
      }
    }
    // grouping is a stable re-sort on top, so rows keep their order within a
    // group whatever the sort column is
    const g = this.grouping();
    if (g) {
      const cmp = g.cmp || ((a, b) => (!a - !b) || cmpText(a, b));   // blanks last
      rows = rows.slice().sort((a, b) => cmp(g.of(a), g.of(b)));
    }
    return rows;
  }

  /* ============================ the tab strip ============================
     Two blocks, one per group, and only one of them is ever being used. Given
     the room they both stay open; short of it, the block you aren't in folds
     down to its name, which is then the button that brings it back — and folds
     the other one away in its place. */
  groupOf(view = this.state.view) {
    return this.tabs.find(t => t.id === view)?.group;
  }

  selectTab(id) {
    this.state.view = id;
    this.render();
  }

  // The width of a block's tabs laid out end to end. Read off the buttons
  // rather than off the strip they're in, because a closed strip is clipped to
  // nothing while its buttons keep the widths they'd have open — which is what
  // makes this answer the same question whichever state we're in, and so what
  // keeps the two states from chasing each other.
  setWidth(set) {
    const gap = parseFloat(getComputedStyle(set).columnGap) || 0;
    return [...set.children].reduce((w, el) => w + el.offsetWidth, 0)
      + gap * Math.max(0, set.children.length - 1);
  }

  layoutTabs() {
    const row = $("#topRow"), tabs = $(".tabs");
    const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const tabsGap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
    // What the header needs if both blocks are open: everything that isn't the
    // tabs or the elastic spacer, at its own width, plus the blocks at theirs.
    let need = rowGap * (row.children.length - 1);
    for (const el of row.children)
      if (el !== tabs && !el.classList.contains("spacer")) need += el.offsetWidth;
    const widths = this.groups.map(g => {
      const set = $("#set-" + g.id);
      return { g, set, w: this.setWidth(set) };
    });
    need += tabsGap * (this.groups.length - 1);
    for (const { g, set, w } of widths)
      need += $("#grp-" + g.id).offsetWidth - set.offsetWidth + w;

    const active = this.groupOf();
    // A few pixels of slack: without it a block can reopen into exactly the
    // space it needs, which is a fold away from being too tight again.
    const narrow = need > row.clientWidth - 12;
    // Everything in the strip that isn't tabs — the two names, the pills'
    // padding, the gap between them. What's left is what the open block has to
    // live in when even one block is more than the window can hold; past that
    // its tabs scroll, which still beats running off the edge of the screen.
    const chrome = tabsGap * (this.groups.length - 1)
      + widths.reduce((n, { g, set }) => n + $("#grp-" + g.id).offsetWidth - set.offsetWidth, 0);
    const room = Math.max(60, row.clientWidth - chrome);

    for (const { g, set, w } of widths) {
      const open = !narrow || g.id === active;
      const grp = $("#grp-" + g.id);
      grp.classList.toggle("closed", !open);
      grp.classList.toggle("on", g.id === active);
      set.style.width = (open ? Math.min(w, room) : 0) + "px";
      set.inert = !open;                 // nothing to tab into behind the fold
      $("#gbtn-" + g.id).title = open
        ? `${g.label} tabs` : `Show the ${g.label} tabs`;
    }
  }

  /* ============================ render ============================ */
  render() {
    const s = this.state;
    // Recorded here rather than where a tab is clicked, because a tab is also
    // arrived at by following a link and by the Back button.
    s.lastTab[this.groupOf()] = s.view;
    for (const t of this.tabs)
      $("#tab-" + t.id).setAttribute("aria-selected", s.view === t.id);
    this.layoutTabs();
    const tab = this.tabs.find(t => t.id === s.view);
    const computed = !!tab?.render;
    $("#tableWrap").classList.toggle("hidden", computed);
    $("#legend").classList.toggle("hidden", computed);
    for (const t of this.tabs)
      if (t.render) $("#pane-" + t.id).classList.toggle("hidden", t.id !== s.view);
    // A computed tab has nothing to search, filter or hide columns in, so the
    // whole control row goes away rather than sitting there inert.
    $("#filterRow").classList.toggle("hidden", computed);
    if (computed) {
      $("#count").textContent = "";
      tab.render($("#pane-" + tab.id), this);
      this.syncAddr();
      this.savePrefs();
      return;
    }

    const v = s.view, def = this.views[v], cols = this.visibleCols();
    const rows = this.activeRows();
    // Every data tab is one file, so "about this tab" is that file's docs.
    const about = $("#aboutLink");
    about.href = docsURL(def.file);
    about.title = `What the columns in ${def.file} mean — the docs on GitHub`;
    this.renderHead(cols);
    const shown = this.renderBody(cols, rows);

    const total = s.rows[v].length;
    $("#count").innerHTML = `<b>${shown}</b>${shown !== total ? ` / ${total}` : ""} rows`;
    $("#clearBtn").disabled = !(Object.keys(s.filters[v]).length || s.q);
    this.renderLegend(rows);
    requestAnimationFrame(() => this.setStickyWidth());
    def.afterRender?.(rows, this);
    this.syncAddr();
    this.savePrefs();
  }

  renderHead(cols) {
    const v = this.state.view, sort = this.state.sort[v];
    $("#thead").replaceChildren(...cols.map(c => {
      const th = document.createElement("th");
      const filtered = !!this.state.filters[v][c.k];
      const mark = sort.k !== c.k ? "" : sort.dir > 0 ? "▲" : sort.dir < 0 ? "▼" : "▤";
      const how = this.views[v].sortHelp?.(c.k) || "sort by " + c.k;
      th.innerHTML = `<div class="h">
        <span class="name" role="button" tabindex="0" title="${c.title ? esc(c.title) + " — " : ""}${esc(how)}">
          <span class="txt">${esc(c.k)}</span><span class="arrow">${mark}</span></span>
        <button class="funnel" title="Filter ${esc(c.k)}"${filtered ? " data-on" : ""}>${FUNNEL_SVG}</button></div>`;
      const name = th.querySelector(".name");
      name.addEventListener("click", () => this.sortBy(c.k));
      name.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.sortBy(c.k); }
      });
      th.querySelector(".funnel").addEventListener("click", e => {
        e.stopPropagation(); this.openFilter(c.k, e.currentTarget);
      });
      return th;
    }));
  }

  renderBody(cols, rows) {
    const s = this.state, v = s.view, def = this.views[v];
    const g = this.grouping();
    const frag = document.createDocumentFragment();
    let shown = 0, prevKey = null;

    const groups = new Map();
    if (g) for (const r of rows) {
      const k = g.of(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    rows.forEach((r, i) => {
      if (g) {
        const key = g.of(r);
        if (key !== prevKey) {
          prevKey = key;
          frag.append(this.groupRow(g, key, groups.get(key), cols.length));
        }
        if (s.collapsed[v].has(key)) return;
      }
      shown++;
      frag.append(this.dataRow(r, cols, i, rows));
      if (def.detail && s.expanded[v].has(r[def.key])) frag.append(this.detailRow(r, cols.length));
    });

    const tbody = $("#tbody");
    tbody.replaceChildren(frag);
    // a class on the tbody is how a view turns on a whole-table presentation
    // (the inventory's cold-episode banding); it can depend on the sort
    tbody.className = (typeof def.tbodyClass === "function"
      ? def.tbodyClass(s.sort[v]) : def.tbodyClass) || "";
    return shown;
  }

  groupRow(g, key, rows, span) {
    const v = this.state.view;
    const collapsed = this.state.collapsed[v].has(key);
    const tr = document.createElement("tr");
    tr.className = "grp";
    const td = document.createElement("td");
    td.colSpan = span;
    const sub = g.sub?.(key, rows);
    td.innerHTML = `<div><span><span class="tw">${collapsed ? "▸" : "▾"}</span>`
      + `${esc(g.label ? g.label(key, rows) : key || "—")} <span class="n">${rows.length}</span>`
      + (sub ? `<span class="sub">${esc(sub)}</span>` : "") + `</span></div>`;
    td.addEventListener("click", () => {
      collapsed ? this.state.collapsed[v].delete(key) : this.state.collapsed[v].add(key);
      this.render();
    });
    tr.append(td);
    return tr;
  }

  dataRow(row, cols, index, rows) {
    const v = this.state.view, def = this.views[v];
    const tr = document.createElement("tr");

    // colour: a flat tint, optionally covered by stripes when the row is about
    // more than one organism. The flat tint stays set either way — the "hi"
    // left-edge bar is derived from it.
    const t = def.tint?.(row);
    if (t) {
      tr.dataset.tint = "";
      paint(tr, t);
      const many = def.tints?.(row);
      if (many && many.length > 1) {
        const bg = stripes(many);
        if (bg) tr.style.backgroundImage = bg;
      }
    }
    if (def.hi?.(row)) tr.dataset.hi = "";
    def.decorate?.(tr, row, index, rows);

    for (const c of cols) {
      const td = document.createElement("td");
      if (c.t.cls) td.className = c.t.cls;
      if (c.t.style) td.style.cssText = c.t.style;
      const val = row[c.k] ?? "";
      if (!def.cell?.(td, c, row, val)) this.defaultCell(td, c, val);
      if (td.classList.contains("clip") && val) {
        td.title = val;
        td.addEventListener("click", () => td.classList.toggle("open"));
      }
      if (def.detail && c === cols[0]) td.prepend(this.twisty(row, def));
      tr.append(td);
    }
    return tr;
  }

  /* ---- detail rows ----
     A view whose rows are a roll-up of several underlying ones (the cDNA tab: a
     tube, and the draws that emptied it) can hand those out on demand rather
     than in a second table. The summary is what the table sorts and filters
     over; the detail is the working underneath it. */
  twisty(row, def) {
    const v = this.state.view, key = row[def.key];
    const open = this.state.expanded[v].has(key);
    const b = document.createElement("button");
    b.className = "exp";
    b.textContent = open ? "▾" : "▸";
    b.title = open ? "Hide the detail" : def.detail.title || "Show the detail";
    b.setAttribute("aria-expanded", open);
    b.addEventListener("click", e => {
      e.stopPropagation();
      open ? this.state.expanded[v].delete(key) : this.state.expanded[v].add(key);
      this.render();
    });
    return b;
  }

  detailRow(row, span) {
    const def = this.view(), d = def.detail;
    const rows = d.of(row, this) || [];
    const tr = document.createElement("tr");
    tr.className = "det";
    const td = document.createElement("td");
    td.colSpan = span;
    // Sticky rather than in flow, so the detail stays where it can be read when
    // the (much wider) table above it is scrolled sideways.
    const box = document.createElement("div");
    if (!rows.length) {
      box.className = "empty";
      box.textContent = d.empty || "nothing recorded";
    } else {
      const t = document.createElement("table");
      const head = document.createElement("tr");
      head.innerHTML = d.cols.map(c => `<th>${esc(c.k)}</th>`).join("");
      const body = document.createElement("tbody");
      for (const r of rows) {
        const line = document.createElement("tr");
        for (const c of d.cols) {
          const cell = document.createElement("td");
          if (c.t.cls) cell.className = c.t.cls;
          const val = r[c.k] ?? "";
          if (!d.cell?.(cell, c, r, val, row)) this.defaultCell(cell, c, val);
          line.append(cell);
        }
        body.append(line);
      }
      t.append(document.createElement("thead"), body);
      t.firstChild.append(head);
      box.append(t);
    }
    td.append(box);
    tr.append(td);
    return tr;
  }

  defaultCell(td, c, val) {
    if (c.t.badge) {
      td.innerHTML = val ? `<span class="badge">${esc(val)}</span>` : "";
    } else if (c.t.tick) {
      td.innerHTML = /^(y|yes|true|✓)$/i.test(val) ? '<span class="tick">✓</span>'
        : val ? `<span class="badge">${esc(val)}</span>` : "";
    } else if (c.t.url && /^https?:\/\//i.test(val)) {
      // scheme-checked rather than linked blind: href takes a javascript: URL
      // just as happily as an http one, and this is CSV text
      const a = document.createElement("a");
      a.href = val;
      a.textContent = val.replace(/^https?:\/\/(www\.)?/i, "");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      td.append(a);
    } else {
      td.textContent = val;
    }
  }

  // how far a heading has to slide right to stay clear of the sticky first column
  setStickyWidth() {
    const first = $("#thead th");
    document.documentElement.style.setProperty(
      "--stick", first ? Math.round(first.getBoundingClientRect().width) + "px" : "0px");
  }

  /* ---- legend ----
     The tool decides what the chips mean; the bar, the pressed state and the
     click plumbing are the same either way. */
  renderLegend(rows) {
    const el = $("#legend");
    const spec = this.views[this.state.view].legend?.(rows, this);
    el.replaceChildren();
    el.classList.toggle("hidden", !spec);
    // A legend is normally the key to the row colours. A `plain` one isn't —
    // it's a set of values to filter by, for a view whose rows aren't coloured
    // at all — so its chips drop the swatch that would promise a colour.
    el.classList.toggle("plain", !!spec?.plain);
    if (!spec) return;
    const active = this.chipKey();
    if (spec.label) el.insertAdjacentHTML("beforeend", `<span class="lbl">${esc(spec.label)}</span>`);
    for (const chip of spec.chips || []) {
      const b = document.createElement("button");
      b.className = "chip";
      paint(b, chip.tint ?? tint(chip.key));
      b.setAttribute("aria-pressed", active === chip.key);
      b.innerHTML = `<span class="sw"></span>${esc(chip.label ?? chip.key)}`
        + (chip.count === undefined ? "" :
           ` <span class="n">${chip.count}${chip.sub ? "·" + esc(chip.sub) : ""}</span>`);
      if (chip.title) b.title = chip.title;
      b.addEventListener("click", () => this.toggleChip(chip.key));
      el.append(b);
    }
    for (const note of spec.notes || [])
      el.insertAdjacentHTML("beforeend", `<span class="sep"></span><span class="note"${
        note.title ? ` title="${esc(note.title)}"` : ""}${
        note.hue !== undefined ? ` style="--h:${note.hue}"` : ""}>${note.html}</span>`);
  }

  /* A chip is the same thing a link is — one value asked for on one column —
     so it goes through the same path, and pressing it puts that value in the
     address bar where it can be copied and sent to someone. */
  toggleChip(key) {
    const v = this.state.view, col = this.views[v].chipCol;
    if (this.chipKey() === key) {
      delete this.state.filters[v][col];
      this.unspec(v, col);
    } else {
      this.applySpec(v, { [col]: [key] });
    }
    this.render();
  }

  sortBy(k) {
    const v = this.state.view, s = this.state.sort[v];
    const next = this.views[v].nextSort?.(k, s);
    if (next) Object.assign(s, next);
    else if (s.k !== k) { s.k = k; s.dir = 1; }
    else s.dir = -s.dir;
    this.render();
  }

  /* ============================ menus ============================ */
  place(pop, anchor) {
    pop.showPopover();
    const r = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left, innerWidth - p.width - 6)) + "px";
    pop.style.top = Math.min(r.bottom + 4, innerHeight - p.height - 6) + "px";
  }

  openFilter(k, anchor) {
    const v = this.state.view, pop = $("#filterMenu");
    const counts = new Map();
    for (const r of this.state.rows[v]) {
      const val = r[k] ?? "";
      counts.set(val, (counts.get(val) || 0) + 1);
    }
    const col = this.views[v].cols.find(c => c.k === k);
    const cmp = col?.t.cmp || cmpText;
    const values = [...counts.keys()].sort((a, b) => (!a) - (!b) || cmp(a, b));
    const sel = this.state.filters[v][k] || new Set(values);

    pop.innerHTML = `<div class="menu-head">
        <input type="search" placeholder="Filter ${esc(k)}…" autocomplete="off">
        <button class="lnk" data-all>All</button><button class="lnk" data-none>None</button>
      </div><div class="menu-body"></div>`;
    const body = $(".menu-body", pop), search = $("input[type=search]", pop);
    const draw = (needle = "") => {
      const shown = values.filter(x => !needle || String(x).toLowerCase().includes(needle));
      body.replaceChildren();
      if (!shown.length) { body.innerHTML = '<div class="empty">no matches</div>'; return; }
      for (const val of shown) {
        const l = document.createElement("label");
        l.innerHTML = `<input type="checkbox"${sel.has(val) ? " checked" : ""}>
          <span class="v">${val ? esc(val) : "<i>(blank)</i>"}</span><span class="c">${counts.get(val)}</span>`;
        $("input", l).addEventListener("change", e => {
          e.target.checked ? sel.add(val) : sel.delete(val);
          commit();
        });
        body.append(l);
      }
    };
    const commit = () => {
      if (sel.size === values.length) delete this.state.filters[v][k];
      else this.state.filters[v][k] = new Set(sel);
      // The column menu can express selections no link or chip stands for, so
      // the intent recorded for this column no longer describes it — drop it,
      // which also unpresses a chip that would be claiming credit for it.
      this.unspec(v, k);
      this.render();
    };
    const needle = () => search.value.toLowerCase().trim();
    search.addEventListener("input", () => draw(needle()));
    $("[data-all]", pop).addEventListener("click", () => { values.forEach(x => sel.add(x)); draw(needle()); commit(); });
    $("[data-none]", pop).addEventListener("click", () => { sel.clear(); draw(needle()); commit(); });
    draw();
    this.place(pop, anchor);
    search.focus();
  }

  buildColsMenu() {
    const v = this.state.view, pop = $("#colsMenu");
    pop.innerHTML = `<div class="menu-head"><b>Columns</b>
        <button class="lnk" data-all>All</button><button class="lnk" data-reset>Reset</button>
      </div><div class="menu-body"></div>`;
    const body = $(".menu-body", pop);
    for (const c of this.views[v].cols) {
      const l = document.createElement("label");
      l.innerHTML = `<input type="checkbox"${this.state.hidden[v].has(c.k) ? "" : " checked"}>
        <span class="v">${esc(c.k)}</span>`;
      $("input", l).addEventListener("change", e => {
        e.target.checked ? this.state.hidden[v].delete(c.k) : this.state.hidden[v].add(c.k);
        this.render();
      });
      body.append(l);
    }
    const again = () => { this.buildColsMenu(); this.render(); pop.showPopover(); };
    $("[data-all]", pop).addEventListener("click", () => { this.state.hidden[v].clear(); again(); });
    $("[data-reset]", pop).addEventListener("click", () => {
      this.state.hidden[v] = new Set(this.views[v].cols.filter(c => c.off).map(c => c.k));
      again();
    });
  }

  /* ============================ wiring ============================ */
  wire() {
    $("#colsBtn").addEventListener("click", () => {
      this.buildColsMenu();
      requestAnimationFrame(() => this.place($("#colsMenu"), $("#colsBtn")));
    });
    $("#colsMenu").addEventListener("beforetoggle", e => {
      $("#colsBtn").setAttribute("aria-expanded", e.newState === "open");
    });
    for (const t of this.tabs)
      $("#tab-" + t.id).addEventListener("click", () => this.selectTab(t.id));
    // A block's name takes you into that block, at the tab you were last on in
    // it. That is what the button is for when the block is folded shut, and it
    // does no harm when it's open.
    for (const g of this.groups)
      $("#gbtn-" + g.id).addEventListener("click", () => this.selectTab(this.state.lastTab[g.id]));
    $("#q").addEventListener("input", e => { this.state.q = e.target.value; this.render(); });
    $("#clearBtn").addEventListener("click", () => {
      const v = this.state.view;
      this.state.filters[v] = {};
      this.unspec(v);
      this.state.q = ""; $("#q").value = "";
      this.render();
    });
    /* Following one of the page's own links, or the Back button after one. Our
       own writes go through replaceState, which doesn't fire this. Going back
       to a bare URL means leaving the address behind, so the filters it
       brought with it go too — but not the search box, which was never part of
       what the link claimed. */
    addEventListener("hashchange", () => {
      if (hasAddr()) this.readAddr(parseHash());
      else {
        const v = this.state.view;
        if (this.names.includes(v)) { this.state.filters[v] = {}; this.unspec(v); }
      }
      this.render();
    });
    $("#reloadBtn").addEventListener("click", () => this.reload());
    $("#live").addEventListener("animationend", e => { e.target.hidden = true; });
    // Now that there's more than one source, this returns to the card and lets
    // the card ask — rather than assuming a folder is what's wanted.
    $("#folderBtn").addEventListener("click", () => this.showLanding());
    $("#pickDir").addEventListener("click", () => this.pickDirectory());
    $("#pickFiles").addEventListener("click", () => $("#fileInput").click());
    $("#dirInput").addEventListener("change", e => this.loadFromFileList(e.target.files));
    $("#fileInput").addEventListener("change", e => this.loadFromFileList(e.target.files));

    $("#ghLoad").addEventListener("click", () => {
      const v = $("#ghToken").value.trim();
      if (v) { ghSetToken(v); this.syncGhButtons(); }
      this.loadFromGitHub();
    });
    $("#ghToken").addEventListener("keydown", e => {
      if (e.key === "Enter") $("#ghLoad").click();
    });
    $("#ghForget").addEventListener("click", () => {
      ghSetToken("");
      this.syncGhButtons();
      $("#ghToken").value = "";
      this.ghUnwatch();
      if (this.state.source === "github") { this.state.source = ""; this.savePrefs(); }
      this.showLanding();
      this.err("Token forgotten.");
    });
    // A poll skipped while hidden shouldn't mean stale data on the way back,
    // and coming back to the window shouldn't mean waiting out a tick either.
    // ghPoll ignores the second of these when they fire together.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.state.source === "github") this.ghPoll();
    });
    addEventListener("focus", () => {
      if (this.state.source === "github") this.ghPoll();
    });
    addEventListener("resize", () => this.setStickyWidth());   // tabs: see the observer in start()

    document.addEventListener("keydown", e => {
      if (e.key === "/" && e.target === document.body) { e.preventDefault(); $("#q").focus(); }
      if (e.key === "Escape" && e.target === $("#q")) {
        $("#q").value = ""; this.state.q = ""; this.render();
      }
    });

    /* drag & drop: the folder, or the CSVs themselves */
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    addEventListener("dragover", e => { stop(e); $("#card")?.classList.add("drop"); });
    addEventListener("dragleave", e => { stop(e); $("#card")?.classList.remove("drop"); });
    addEventListener("drop", async e => {
      stop(e); $("#card")?.classList.remove("drop"); this.err("");
      for (const it of [...e.dataTransfer.items]) {
        if (it.kind !== "file" || !it.getAsFileSystemHandle) continue;
        try {
          const h = await it.getAsFileSystemHandle();
          if (h?.kind === "directory") { await this.loadFromDirHandle(h); return; }
        } catch {}
      }
      const files = [...e.dataTransfer.files];
      if (files.length) await this.loadFromFileList(files);
      else this.err("Drop the data folder, or the CSVs together.");
    });
  }
}

/* ============================ stats helpers ============================
   Both tools show a computed tab built out of the same kind of table: a row
   per measure, a column per bucket, percentages washed with a heat colour. */
function statTable(cols, rows) {
  const t = document.createElement("table");
  t.className = "stat";
  const thead = document.createElement("thead"), head = document.createElement("tr");
  head.innerHTML = "<th></th>" + cols.map(c => `<th>${esc(c)}</th>`).join("");
  thead.append(head);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.sep) tr.classList.add("sep");
    const th = document.createElement("th");
    th.textContent = r.label;
    if (r.tip) th.title = r.tip;
    tr.append(th);
    for (const c of cols) {
      const td = document.createElement("td");
      const v = r.vals[c];
      if (v === null || v === undefined || v === "") { td.textContent = "—"; td.className = "blank"; }
      else if (r.pct) {
        td.textContent = Math.round(v * 100) + "%";
        td.className = "heat";
        // pale at 50% and below, saturated green at 100%
        const k = Math.max(0, Math.min(1, (v - 0.5) * 2));
        td.style.setProperty("--hl", (0.97 - 0.29 * k).toFixed(3));
        td.style.setProperty("--hc", (0.012 + 0.078 * k).toFixed(3));
      } else td.textContent = v;
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

/* The blocks of tabs, in the order they were loaded: inventory.js and
   results.js each declare one as they run, and data.js hands the lot to the
   App. A group is { id, label, views, tabs, required, ingest } — the same
   config the App used to take whole, now one per block. */
const groups = [];
const group = g => { groups.push(g); return g; };

return {
  App, T, DATA_FILES, TINTS, groups, group,
  link, extLink, hrefFor, buildHash, parseHash,
  $, esc, parseCSV, toObjects,
  dnum, dateOnly, yearOf, labelKey, cmpLabel, cmpText, cmpNum, cmpDate,
  median, round,
  tint, paint, stripes, hueOf, hasHue, isWarm,
  statTable,
};

})();
