/* qpcr.js — the qPCR results browser.
 *
 * `data/qPCR-results.csv` is one row per well × channel, every legitimate run
 * this lab has done since June 2020. Individual experiment notes say what
 * happened on a day; this file exists for the cross-experiment questions, and
 * this tool is for asking them: what Cq does `ENT rc` usually give, how far
 * back does an assay's contamination go, what has ever been run on S90.
 *
 * Three tables over the same rows — the wells themselves, rolled up per assay,
 * and rolled up per sample — plus a per-year summary. The generic machinery
 * (folder, sorting, filtering, columns, legend) is dataview.js; the same
 * folder and the same species colours as the inventory.
 */
"use strict";

(() => {
const { T, esc, dnum, dateOnly, yearOf, cmpLabel, cmpText, median, round,
        hasHue, hueOf, isWarm, statTable } = Dataview;

/* ============================ conventions ============================ */

/* A blank Cq means no amplification was detected. The Biomeme-era rows wrote
   `0.0` for that instead and most rows in the file still do, so the two are
   the same thing — and mixing a `0.0` into arithmetic as a real value is the
   single most likely way to get a wrong answer out of this file. Everything
   numeric here goes through cq(), and the table draws both as an em dash. */
function cq(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// No Cq sorts *after* every real one, so ascending Cq reads best-first.
const cmpCq = (a, b) => (cq(a) ?? Infinity) - (cq(b) ?? Infinity);

/* Channel follows from the probe and the instrument, and since the instrument
   isn't a column of its own, the channel names are what identify it: the
   Biomeme Franklin reads green / amber / red, the Bio-Rad CFX96 Ch1 / Ch3 /
   Ch4. Worth surfacing, because the two don't give the same numbers — the
   first side-by-side comparison had the CFX96 calling Cq ~3 cycles later. */
const CHANNELS = ["green", "amber", "red", "Ch1", "Ch2", "Ch3", "Ch4", "Ch5"];
const instrumentOf = ch => /^Ch\d/i.test(ch) ? "CFX96" : ch ? "Biomeme" : "";
const cmpChannel = (a, b) => {
  const i = CHANNELS.indexOf(a), j = CHANNELS.indexOf(b);
  return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || cmpText(a, b);
};

const POSITIVE = "Positive";
const isPositive = r => r.Determination === POSITIVE;

/* A run is a Date — the column carries an approximate time exactly so that two
   runs on one day stay apart. Newest run first. */
const runOf = r => r.Date || "";
const cmpRun = (a, b) => (!a - !b) || (dnum(b) ?? -Infinity) - (dnum(a) ?? -Infinity)
  || cmpText(b, a);

// dir 0 on the Date column is the third click: gather each run into a group
const runSort = s => s.k === "Date" && s.dir === 0;

/* Several assays in one well are recorded joined with " + ", and each part
   resolves separately (a bare "+" is part of a name — `Covid19 N+RdRP ys`). */
const parts = v => String(v || "").split(" + ").map(s => s.trim()).filter(Boolean);
const speciesOf = row => parts(row.Species);

/* ============================ derived state ============================ */
const lab = {
  primer: new Map(),      // lower-cased primers.csv Label -> row
  primerLabels: [],       // same keys, longest first, for the prefix fallback
  source: new Map(),      // samples.csv Label -> Source
};

/* `Primer` names the assay as it was *prepared*, so it matches a reagent tube
   first and a primers.csv design only through it — and a reagent label is a
   design label plus a qualifier (`HRV ma grn`, `ADV ri 100`). Try the name as
   written, then fall back to the longest design label it starts with. */
function design(name) {
  const key = name.toLowerCase();
  const exact = lab.primer.get(key);
  if (exact) return exact;
  const pre = lab.primerLabels.find(l => key.startsWith(l + " "));
  return pre ? lab.primer.get(pre) : null;
}

/* An assay with no species behind it is a host control (B2M, RP, RNaseP ys) or
   an unresolved panel name — either way not something a sample can be said to
   have tested positive *for*. */
const isTarget = name => !!(design(name)?.Species || "").trim();

// The organisms a well's assays are looking for — what colours the row.
function assaySpecies(primer, unknown) {
  const out = [];
  for (const name of parts(primer)) {
    const d = design(name);
    if (!d) { unknown?.set(name, (unknown.get(name) || 0) + 1); continue; }
    const sp = (d.Species || "").trim();
    if (sp && !out.includes(sp)) out.push(sp);
  }
  return out;
}

/* ============================ the legend ============================ */
function speciesLegend(rows, app) {
  const counts = new Map(), posCounts = new Map();
  for (const r of app.state.rows[app.state.view]) {
    const pos = app.views[app.state.view].hi(r);
    for (const s of speciesOf(r)) {
      counts.set(s, (counts.get(s) || 0) + 1);
      if (pos) posCounts.set(s, (posCounts.get(s) || 0) + 1);
    }
  }
  if (!counts.size) return null;
  // viruses first by hue, then the bacteria and fungi as one tan block — the
  // same order the inventory's legend uses, for the same reason
  const order = [...counts.entries()].sort((a, b) =>
    isWarm(a[0]) - isWarm(b[0]) || hueOf(a[0]) - hueOf(b[0]) || a[0].localeCompare(b[0]));
  return {
    label: "Target",
    chips: order.map(([s, n]) => ({
      key: s, count: n,
      sub: posCounts.get(s) ? posCounts.get(s) + "+" : "",
      title: `${n} row${n > 1 ? "s" : ""}`
        + (posCounts.get(s) ? `, ${posCounts.get(s)} positive` : "") + " — click to filter",
    })),
    notes: [{ html: '<span class="dk"></span> darker = positive', hue: 145 }],
  };
}

// Colouring is by what the assay targets, so it is the same on all three
// tables; only "what counts as a hit" differs, which is `hi`.
const coloured = {
  tint: r => { const sp = speciesOf(r); const s = sp.find(hasHue) || sp[0]; return s ? Dataview.tint(s) : null; },
  tints: speciesOf,
  legend: speciesLegend,
  chipCol: "Species",
  chipMatch: (r, key) => speciesOf(r).includes(key),
};

// Species and Determination render the same way wherever they appear.
function commonCell(td, c, row, val) {
  if (c.k === "Species") {
    td.innerHTML = speciesOf(row).map(s => `<span class="badge">${esc(s)}</span>`).join(" ");
    return true;
  }
  if (c.k === "Determination") {
    td.innerHTML = val
      ? `<span class="badge det" data-det="${esc(val.replace(/[^A-Za-z]/g, ""))}">${esc(val)}</span>` : "";
    return true;
  }
  if (c.t.cq) {
    const n = cq(val);
    if (n === null) {
      td.className += " none";
      td.textContent = "—";
      td.title = val ? `recorded as ${val} — no Cq was called` : "no Cq was called";
      return true;
    }
  }
  return false;
}

/* ============================ views ============================ */
const num = T.num;
// a Cq column: sorts no-result last, and draws it as an em dash
const cqCol = { cls: "num", cmp: cmpCq, cq: true };

const views = {
  results: {
    label: "Results",
    key: "Sample",
    ...coloured,
    hi: isPositive,
    sort: { k: "Date", dir: 0 },                // grouped by run
    group: {
      when: runSort,
      of: runOf,
      cmp: cmpRun,
      label: k => k || "(no date)",
      // what the run was: the instrument, and the assays it carried
      sub: (k, rows) => {
        const inst = [...new Set(rows.map(r => instrumentOf(r.Channel)).filter(Boolean))];
        const assays = [...new Set(rows.flatMap(r => parts(r.Primer)))];
        const pos = rows.filter(isPositive).length;
        return [
          inst.join("/"),
          assays.slice(0, 6).join(", ") + (assays.length > 6 ? `, +${assays.length - 6}` : ""),
          pos ? `${pos} positive` : "",
        ].filter(Boolean).join(" · ");
      },
    },
    cols: [
      // pooled samples are joined with + and get long, and this is the sticky
      // column — so it clips, and a click opens the one row that needs it
      { k: "Sample",   t: { cls: "clip sample", cmp: cmpLabel },
        title: "Sample label, indexing samples.csv; NTC for a no-template control" },
      { k: "Date",     t: T.date, title: "The run — the join key into experiments/" },
      { k: "Species",  t: T.flag, title: "What this well's assays target, via primers.csv" },
      { k: "Primer",   t: T.flag, title: "The assay as it was prepared" },
      { k: "Determination", t: T.flag, title: "The subjective call for this well/channel — expected to change as later experiments learn more" },
      { k: "Cq",       t: cqCol, title: "Quantification cycle; blank and 0.0 both mean no amplification was called" },
      { k: "∆RFU",     t: num, title: "Total fluorescence gain — the height of the curve. Low tens is noise; a real amplification is typically 1000+" },
      { k: "Melt peak", t: num, title: "Melting temperature of the dominant melt-curve peak (°C)" },
      { k: "Melt shape", t: T.clip, off: true },
      { k: "Well",     t: T.label },
      { k: "Channel",  t: { cls: "nowrap", cmp: cmpChannel } },
      { k: "Probe",    t: T.flag },
      { k: "Instrument", t: T.flag, off: true, title: "Implied by the channel names — the two instruments' Cq values aren't comparable" },
      { k: "Label",    t: T.flag, off: true, title: "The well's name as written in that day's experiment note" },
      { k: "Source",   t: T.flag, off: true, title: "Who the sample came from, via samples.csv" },
      { k: "Extraction", t: T.flag },
      { k: "RT",       t: T.flag, title: "Reverse transcription; NO for a DNA target or an RT-negative control" },
      { k: "MM",       t: T.flag, off: true, title: "PCR master mix" },
      { k: "Conc  nM", t: T.flag, off: true, title: "Oligo concentration in the reaction: one value, primers/probe, or fwd/rev/probe" },
      { k: "Mod",      t: T.flag, off: true, title: "Protocol modification (UDG, added intercalating dye)" },
      { k: "DNase",    t: T.flag, off: true },
      { k: "T-Anneal", t: num, off: true, title: "Anneal/extension temperature (°C)" },
      { k: "T-RT",     t: num, off: true, title: "Reverse transcription temperature (°C)" },
      { k: "Multiplex", t: num, off: true, title: "Number of assays sharing this well" },
      { k: "Threshold", t: num, off: true, title: "The RFU threshold the software called Cq against — Cq is sensitive to it" },
      { k: "Dye Cq",   t: { ...cqCol }, off: true, title: "A second Cq for the same well, read from an intercalating dye" },
      { k: "Norm Cq",  t: { ...cqCol }, off: true, title: "Cq adjusted to a common sample input, so runs loading different amounts compare" },
      { k: "SVol µl",  t: num, off: true, title: "Volume of sample put into the reaction" },
      { k: "SDilution", t: T.flag, off: true, title: "Fraction of the whole original sample present in the reaction" },
      { k: "Conc.",    t: num, off: true, title: "Estimated nucleic acid concentration, ng/µL" },
      { k: "∆Cq exp",  t: num, off: true, title: "Difference in Cq against a reference gene, for expression experiments" },
      { k: "Notes",    t: T.clip },
    ],
    // Date leads with grouped-by-run, then cycles ▼ → ▲
    nextSort(k, s) {
      if (k !== "Date") return null;
      if (s.k !== k) return { k, dir: 0 };
      return { k, dir: s.dir === 0 ? -1 : s.dir === -1 ? 1 : 0 };
    },
    sortHelp: k => k === "Date" ? "gather each run into a group, then sort by Date" : null,
    // in run order the wells read as the plate was laid out
    sortRows(rows, sort) {
      if (!runSort(sort)) return null;
      return rows.slice().sort((a, b) =>
        cmpRun(runOf(a), runOf(b)) || cmpLabel(a.Well, b.Well) || cmpChannel(a.Channel, b.Channel));
    },
    decorate(tr, r) {
      // Failed is "the run didn't work here", not a result — kept, but muted
      if (r.Determination === "Failed") tr.classList.add("dim");
    },
    cell: commonCell,
  },

  assays: {
    label: "Assays",
    key: "Primer",
    ...coloured,
    hi: r => +r.Positive > 0,
    sort: { k: "Wells", dir: -1 },
    cols: [
      { k: "Primer",   t: T.label, title: "The assay as prepared. The same target with a different reference is a different assay" },
      { k: "Species",  t: T.flag },
      { k: "Description", t: T.clip, title: "From primers.csv, via the design this preparation is of" },
      { k: "Wells",    t: num, title: "Rows in qPCR-results.csv naming this assay" },
      { k: "Runs",     t: num, title: "Distinct dates it was used on" },
      { k: "Positive", t: num },
      { k: "Negative", t: num, off: true },
      { k: "Contamination", t: num, title: "Amplification attributed to contamination rather than target" },
      { k: "Other",    t: num, off: true, title: "Inconclusive, Failed, or not yet assessed" },
      { k: "Positive %", t: num },
      { k: "Cq median", t: num, title: "Median Cq of the positive wells" },
      { k: "Cq best",  t: num, title: "Lowest Cq ever called on this assay" },
      { k: "∆RFU median", t: num, off: true, title: "Median fluorescence gain of the positive wells" },
      { k: "Melt",     t: num, off: true, title: "Median melt peak (°C) of the positive wells" },
      { k: "Product Tm", t: num, off: true, title: "Melt temperature the design expects — compare with Melt" },
      { k: "Probe",    t: T.flag, off: true, title: "Probe dyes this assay has been read on" },
      { k: "First",    t: T.date },
      { k: "Last",     t: T.date },
      { k: "Author",   t: T.flag, off: true, title: "Whose published design it is, from primers.csv" },
    ],
    cell: commonCell,
  },

  samples: {
    label: "Samples",
    key: "Sample",
    ...coloured,
    hi: r => +r.Positive > 0,
    sort: { k: "Last", dir: -1 },
    cols: [
      { k: "Sample",   t: T.label },
      { k: "Source",   t: T.flag, title: "Who it came from, via samples.csv" },
      { k: "Species",  t: T.flag, title: "What it tested positive for" },
      { k: "Found",    t: T.clip, title: "The assays that called it positive, host controls aside" },
      { k: "Wells",    t: num },
      { k: "Runs",     t: num },
      { k: "Assays",   t: num, title: "Distinct assays ever run against this sample" },
      { k: "Positive", t: num },
      { k: "Contamination", t: num, off: true },
      { k: "Cq best",  t: num, title: "Lowest Cq called on any positive well" },
      { k: "B2M",      t: num, title: "Best Cq on the B2M host control — how much human material the extraction got" },
      { k: "Tested",   t: T.clip, off: true, title: "Every assay ever run against this sample" },
      { k: "First",    t: T.date },
      { k: "Last",     t: T.date },
    ],
    cell: commonCell,
  },
};

/* ============================ roll-ups ============================ */
function tally(rows) {
  const t = { Positive: 0, Negative: 0, Contamination: 0, Other: 0 };
  for (const r of rows) {
    const d = r.Determination;
    if (d === POSITIVE) t.Positive++;
    else if (d === "Negative") t.Negative++;
    else if (/^Contamination/.test(d)) t.Contamination++;
    else t.Other++;
  }
  return t;
}
// first / last date a set of rows covers, as the plain dates they're filed under
function dates(rows) {
  let lo = null, hi = null, loS = "", hiS = "";
  for (const r of rows) {
    const t = dnum(r.Date);
    if (t === null) continue;
    if (lo === null || t < lo) { lo = t; loS = dateOnly(r.Date); }
    if (hi === null || t > hi) { hi = t; hiS = dateOnly(r.Date); }
  }
  return [loS, hiS];
}
const count = (rows, f) => String(rows.filter(f).length);
const uniq = xs => [...new Set(xs.filter(Boolean))];

function assayRows(results) {
  const by = new Map();
  for (const r of results) for (const name of parts(r.Primer)) {
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(r);
  }
  return [...by].map(([name, rows]) => {
    const t = tally(rows);
    const pos = rows.filter(isPositive);
    const cqs = pos.map(r => cq(r.Cq)).filter(n => n !== null);
    const all = rows.map(r => cq(r.Cq)).filter(n => n !== null);
    const rfu = pos.map(r => parseFloat(r["∆RFU"])).filter(Number.isFinite);
    const melt = pos.map(r => parseFloat(r["Melt peak"])).filter(Number.isFinite);
    const [first, last] = dates(rows);
    const d = design(name) || {};
    return {
      Primer: name,
      Species: (d.Species || "").trim(),
      Description: d.Description || "",
      Wells: String(rows.length),
      Runs: String(uniq(rows.map(runOf)).length),
      ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])),
      "Positive %": rows.length ? String(Math.round(100 * t.Positive / rows.length)) : "",
      "Cq median": round(median(cqs)),
      "Cq best": all.length ? round(Math.min(...all)) : "",
      "∆RFU median": round(median(rfu), 0),
      Melt: round(median(melt)),
      "Product Tm": d["Product Tm"] || "",
      Probe: uniq(rows.map(r => r.Probe)).join(", "),
      Author: d.Author || "",
      First: first, Last: last,
    };
  });
}

function sampleRows(results) {
  const by = new Map();
  for (const r of results) {
    // pooled samples are joined with +, and each one was really tested
    for (const s of String(r.Sample).split("+").map(x => x.trim()).filter(Boolean)) {
      if (!by.has(s)) by.set(s, []);
      by.get(s).push(r);
    }
  }
  return [...by].map(([name, rows]) => {
    const t = tally(rows);
    const pos = rows.filter(isPositive);
    const cqs = pos.map(r => cq(r.Cq)).filter(n => n !== null);
    // B2M says how much human material came through the extraction, so it is
    // read off the control wells rather than counted as a finding
    const b2m = rows.filter(r => /^B2M/i.test(r.Primer)).map(r => cq(r.Cq)).filter(n => n !== null);
    const [first, last] = dates(rows);
    return {
      Sample: name,
      Source: lab.source.get(name) || "",
      Species: uniq(pos.flatMap(r => speciesOf(r))).join(" + "),
      // the host controls (B2M, RNaseP) are positive on nearly every sample
      // that extracted properly, which is the opposite of a finding
      Found: uniq(pos.flatMap(r => parts(r.Primer)).filter(isTarget)).join(", "),
      Wells: String(rows.length),
      Runs: String(uniq(rows.map(runOf)).length),
      Assays: String(uniq(rows.flatMap(r => parts(r.Primer))).length),
      Positive: String(t.Positive),
      Contamination: String(t.Contamination),
      "Cq best": cqs.length ? round(Math.min(...cqs)) : "",
      B2M: b2m.length ? round(Math.min(...b2m)) : "",
      Tested: uniq(rows.flatMap(r => parts(r.Primer))).sort(cmpText).join(", "),
      First: first, Last: last,
    };
  });
}

/* ============================ stats ============================ */
function renderStats(wrap, app) {
  const results = app.state.rows.results;
  const years = uniq(results.map(r => yearOf(r.Date)).filter(Boolean))
    .sort((a, b) => b - a).map(String);
  const cols = ["Total", ...years];
  const bucket = r => String(yearOf(r.Date) || "");
  const per = f => {
    const out = Object.fromEntries(cols.map(c => [c, 0]));
    for (const r of results) if (f(r)) { out.Total++; if (out[bucket(r)] !== undefined) out[bucket(r)]++; }
    return out;
  };
  const distinct = of => {
    const seen = Object.fromEntries(cols.map(c => [c, new Set()]));
    for (const r of results) for (const v of of(r)) {
      seen.Total.add(v);
      seen[bucket(r)]?.add(v);
    }
    return Object.fromEntries(cols.map(c => [c, seen[c].size]));
  };

  const wells = per(() => true);
  const runs = distinct(r => [runOf(r)]);
  // pooled samples are counted as the several samples they are, the same way
  // the Samples tab splits them
  const samples = distinct(r => r.Sample === "NTC" ? []
    : String(r.Sample).split("+").map(s => s.trim()).filter(Boolean));
  const assays = distinct(r => parts(r.Primer));
  const pos = per(isPositive);
  const neg = per(r => r.Determination === "Negative");
  const con = per(r => /^Contamination/.test(r.Determination));
  const rest = per(r => !["Positive", "Negative"].includes(r.Determination)
    && !/^Contamination/.test(r.Determination));
  const ratio = (a, b) => Object.fromEntries(cols.map(c => [c, b[c] ? a[c] / b[c] : null]));

  wrap.replaceChildren();
  wrap.insertAdjacentHTML("beforeend",
    `<h2>Runs by year</h2><p class="sub">One row per well × channel, so <b>wells</b> counts channels
     read, not reactions set up. A <b>run</b> is a distinct <code>Date</code> — the column carries an
     approximate time exactly so two runs on one day stay apart. <b>Samples</b> excludes NTCs.
     Percentages shade from pale at 50% to solid at 100%.</p>`);
  wrap.append(statTable(cols, [
    { label: "Runs", vals: runs, tip: "Distinct dates with results" },
    { label: "Wells read", vals: wells, tip: "Rows in qPCR-results.csv" },
    { label: "Samples", vals: samples, tip: "Distinct samples tested, NTCs excluded" },
    { label: "Assays", vals: assays, tip: "Distinct assay names used" },
    { label: "Positive", vals: pos, sep: true },
    { label: "Negative", vals: neg },
    { label: "Contamination", vals: con },
    { label: "Other", vals: rest, tip: "Inconclusive, Failed, or not yet assessed" },
    { label: "Positive (%)", vals: ratio(pos, wells), pct: true, sep: true },
    { label: "Contamination (%)", vals: ratio(con, wells), pct: true },
  ]));
}

/* ============================ ingest ============================ */
function ingest(tables) {
  const results = tables["qPCR-results.csv"];
  if (!results.cols.includes("Primer")) throw new Error("qPCR-results.csv has no Primer column");

  lab.primer = new Map();
  for (const p of tables["primers.csv"]?.rows || []) {
    const k = (p.Label || "").trim().toLowerCase();
    if (k) lab.primer.set(k, p);
  }
  // longest first, so `HRV ma Cy5` prefers `HRV ma` over `HRV`
  lab.primerLabels = [...lab.primer.keys()].sort((a, b) => b.length - a.length);

  lab.source = new Map();
  for (const s of tables["samples.csv"]?.rows || []) {
    if (s.Label) lab.source.set(s.Label, s.Source || "");
  }

  const unknown = new Map();
  for (const r of results.rows) {
    r.Species = assaySpecies(r.Primer, unknown).join(" + ");
    r.Instrument = instrumentOf(r.Channel);
    r.Source = uniq(String(r.Sample).split("+").map(x => lab.source.get(x.trim()))).join(" + ");
  }

  let notice = "";
  if (!tables["primers.csv"]) {
    notice = "No primers.csv in that folder — rows can't be coloured by what the assay targets.";
  } else if (unknown.size) {
    const list = [...unknown.entries()].sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} (${c})`).join(", ");
    notice = `${unknown.size} assay name${unknown.size > 1 ? "s" : ""} in Primer `
      + `don't resolve against primers.csv — panels and pools mostly: ${list}`;
  }

  return {
    rows: {
      results: results.rows,
      assays: assayRows(results.rows),
      samples: sampleRows(results.rows),
    },
    notice,
  };
}

const app = new Dataview.App({
  title: "qPCR",
  prefsKey: "molbiolab.qpcr.v1",
  required: ["qPCR-results.csv"],
  landing: "Pick the folder holding <code>qPCR-results.csv</code> (plus <code>primers.csv</code> "
    + "for the assay targets and <code>samples.csv</code> for who each sample came from) — the repo "
    + "root or its <code>data/</code> folder both work. Nothing leaves this machine; the page only "
    + "reads the files.",
  views,
  tabs: [{ id: "stats", label: "Stats", render: renderStats }],
  ingest,
});
app.start();

})();
