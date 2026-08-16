/* results.js — the Results block of the data tool: what the assays said.
 *
 * `data/qPCR-results.csv` is one row per well × channel, every legitimate run
 * this lab has done since June 2020, and `data/sequencing.csv` one row per
 * library × run, every attempt to read something out including the ones that
 * read nothing. Individual experiment notes say what happened on a day; those
 * files exist for the cross-experiment questions, and this tool is for asking
 * them: what Cq does `ENT rc` usually give, how far back does an assay's
 * contamination go, what has ever been run on S90, which flow cells were worth
 * the money.
 *
 * Two tables — the wells themselves and the sequencing libraries — plus a
 * per-year summary. One tab per file and no roll-ups: an Assays and a Samples
 * table used to live here, but the Inventory block already has a tab for each
 * of those files, and a tab that was a summary of another tab's rows was the
 * one place in the tool where what you were looking at wasn't a file. The
 * generic machinery (folder, sorting, filtering, columns, legend, the address
 * bar) is dataview.js; the same folder and species colours as the inventory.
 *
 * Tab ids are `res-`-prefixed against the inventory's `inv-`, since the two
 * blocks share one address space. A link into the Inventory tabs is an
 * ordinary link: same page, other block.
 */
"use strict";

(() => {
const { T, esc, dnum, dateOnly, yearOf, cmpLabel, cmpText,
        hasHue, hueOf, isWarm, statTable, link } = Dataview;

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

/* A pooled sample is written `S46+S53+S84`, and each member really was tested —
   so "the wells for S90" has to find the pools S90 sat in as well as its own
   rows. Same convention in cdna.csv and sequencing.csv. */
const pool = v => String(v || "").split("+").map(s => s.trim()).filter(Boolean);

/* ============================ derived state ============================ */
const lab = {
  primer: new Map(),      // lower-cased primers.csv Label -> row
  primerLabels: [],       // same keys, longest first, for the prefix fallback
  source: new Map(),      // samples.csv Label -> Source
  tubes: new Set(),       // cdna.csv Tube labels, so a submitted tube can link
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

// Colouring is by what the assay targets, so it is the same on both tables;
// only "what counts as a hit" differs, which is `hi`.
const coloured = {
  tint: r => { const sp = speciesOf(r); const s = sp.find(hasHue) || sp[0]; return s ? Dataview.tint(s) : null; },
  tints: speciesOf,
  legend: speciesLegend,
  chipCol: "Species",
  /* What one asked-for value is allowed to match, for a legend chip and for a
     link into this tab alike. All three are the same shape of problem: the cell
     holds more than the one thing being asked about. */
  match: {
    Species: (cell, want) => parts(cell).includes(want),
    Sample: (cell, want) => pool(cell).includes(want),
    /* `Primer` is the assay as *prepared*, so a link from a primers.csv design
       (`HRV ma`) has to reach every preparation of it (`HRV ma grn`, `HRV ma
       Cy5`) — the same prefix rule design() resolves by. Case-insensitively,
       both here and on the exact match: the notes write `HRV Ma` and the
       results write `HRV ma`, which is exactly the drift primers.md warns
       about, and a link that respected it would land on an empty table. */
    Primer: (cell, want) => {
      const w = want.toLowerCase();
      return parts(cell).some(p =>
        p.toLowerCase() === w || p.toLowerCase().startsWith(w + " "));
    },
  },
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
  "res-results": {
    // "qPCR" rather than "Results": the block is already called that, and this
    // is the qPCR file next to the sequencing one.
    label: "qPCR",
    file: "qPCR-results.csv",
    key: "Sample",
    ...coloured,
    hi: isPositive,
    sort: { k: "Date", dir: 0 },                // grouped by run
    group: {
      when: runSort,
      of: runOf,
      cmp: cmpRun,
      label: k => k || "(no date)",
      // what the run was: the note it belongs to, the instrument, the assays
      sub: (k, rows) => {
        const exp = [...new Set(rows.map(r => r.Experiment).filter(Boolean))];
        const inst = [...new Set(rows.map(r => instrumentOf(r.Channel)).filter(Boolean))];
        const assays = [...new Set(rows.flatMap(r => parts(r.Primer)))];
        const pos = rows.filter(isPositive).length;
        return [
          exp.join(", "),
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
      { k: "Date",     t: T.date, title: "When the run was read" },
      { k: "Experiment", t: T.clip, title: "The experiments/ folder this row belongs to — the join key into the notes" },
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
      // Multiplex used to be a column here. It was dropped because the count
      // *is* the number of rows sharing a Date/Well, and a stored copy of it
      // went stale the moment a channel was corrected.
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
    cell(td, c, row, val) {
      if (c.k === "Sample" && val && val !== "NTC") {
        // a pool is several samples, and each one has its own row over there
        for (const s of pool(val)) {
          if (td.childNodes.length) td.append("+");
          td.append(link(s, { tab: "inv-samples", spec: { Label: [s] } },
            `${s} in samples.csv`));
        }
        return true;
      }
      // A multiplexed well names several assays, and each of them has a whole
      // history in this same file — so the link filters this tab down to it.
      if (c.k === "Primer" && val) {
        for (const p of parts(val)) {
          if (td.childNodes.length) td.append(" + ");
          td.append(link(p, { tab: "res-results", spec: { Primer: [p] } },
            `Every well ${p} has ever been run in`));
        }
        return true;
      }
      return commonCell(td, c, row, val);
    },
  },

  /* ---- sequencing ----
     `sequencing.csv` is one row per library × run: what went in, and what came
     back out. The failures are the point of keeping it — 48 of the 73 rows
     resolved nothing, and a file of only the successes would answer "what did
     we find?" but never "what does it cost to find it?". So the default view is
     every library, gathered into its run, with the verdict on each. */
  "res-sequencing": {
    label: "Sequencing",
    file: "sequencing.csv",
    key: "Sample",
    ...coloured,
    hi: r => r.Determination === "Genotyped",
    sort: { k: "Date", dir: 0 },                // grouped by run
    group: {
      when: s => s.k === "Date" && s.dir === 0,
      of: r => r.Run || "",
      cmp: (a, b) => (!a - !b) || cmpLabel(b, a),      // newest run first
      label: (k, rows) => {
        const alias = rows.find(r => r.Alias)?.Alias;
        return k + (alias ? ` / ${alias}` : "") || "(no run)";
      },
      // what the run was: when, who did it, on what chemistry, and how it went
      sub: (k, rows) => {
        const one = f => [...new Set(rows.map(f).filter(Boolean))].join(", ");
        const got = rows.filter(r => r.Determination === "Genotyped").length;
        return [dateOnly(rows[0]?.Date), one(r => r.Provider), one(r => r.Service),
                got ? `${got} genotyped` : "nothing genotyped"].filter(Boolean).join(" · ");
      },
    },
    cols: [
      { k: "Sample",   t: { cls: "clip sample", cmp: cmpLabel },
        title: "The samples.csv label sequenced; pooled libraries join their members with +" },
      { k: "Run",      t: T.label, title: "Q1–Q11, the canonical run id — what pathogens.csv cites" },
      { k: "Date",     t: T.date, title: "When the run started, or when samples were submitted to a provider" },
      { k: "Species",  t: T.flag, title: "What the amplicon targets, via primers.csv" },
      { k: "Determination", t: T.flag, title: "The verdict on this library. Blank means none was ever recorded — not that it failed" },
      { k: "Amplicon", t: T.clip, title: "What was amplified: primers.csv designs, or an assays.csv panel" },
      { k: "Tube",     t: T.flag, title: "The tube submitted, as written on it — a cDNA tube, or an amplicon" },
      { k: "Barcode",  t: T.flag, title: "The index separating this library from the others in its run. Blank means the run wasn't barcoded" },
      { k: "Reads",    t: T.num, title: "Total reads assigned to this barcode. 0 is a real value" },
      { k: "On-target", t: T.flag, title: "Reads that hit the intended target — the gap against Reads is the story of a run. Eyeballed off a read-mapping plot, so ranges are kept as written" },
      { k: "Coverage", t: T.flag, off: true, title: "Percent of the target genome covered — only the tiled whole-genome run" },
      { k: "Provider", t: T.flag },
      { k: "Service",  t: T.clip, title: "The chemistry: <flow cell> / <kit> self-run, or the provider's service tier" },
      { k: "Alias",    t: T.flag, off: true, title: "The run's other name, where it has one" },
      { k: "PCR Date", t: T.date, off: true, title: "When the amplicon was made — what tells two tubes of one sample apart" },
      { k: "Conc ng/µL", t: T.num, off: true, title: "Quantus reading before any dilution for submission" },
      { k: "Source",   t: T.flag, off: true, title: "Who the sample came from, via samples.csv" },
      { k: "Data",     t: T.url, off: true, title: "Where the delivered reads live" },
      { k: "Notes",    t: T.clip },
    ],
    nextSort(k, s) {
      if (k !== "Date") return null;
      if (s.k !== k) return { k, dir: 0 };
      return { k, dir: s.dir === 0 ? -1 : s.dir === -1 ? 1 : 0 };
    },
    sortHelp: k => k === "Date" ? "gather each run into a group, then sort by Date" : null,
    decorate(tr, r) {
      // the run itself didn't work under this library — kept, but muted
      if (/^(Failed|No reads)$/.test(r.Determination)) tr.classList.add("dim");
    },
    cell(td, c, row, val) {
      if (c.k === "Sample" && val) {
        for (const s of pool(val)) {
          if (td.childNodes.length) td.append("+");
          td.append(link(s, { tab: "inv-samples", spec: { Label: [s] } },
            `${s} in samples.csv`));
        }
        return true;
      }
      // Where the tube is a cdna.csv row the cDNA was submitted directly, and
      // the ledger says what was left of it afterwards. An amplicon tube isn't
      // tracked as inventory anywhere, so it stays plain text.
      if (c.k === "Tube" && val && lab.tubes.has(val)) {
        td.append(link(val, { tab: "inv-cdna", spec: { Tube: [val] } },
          `${val} in the cDNA ledger`));
        return true;
      }
      return commonCell(td, c, row, val);
    },
  },
};

/* ============================ helpers ============================ */
const uniq = xs => [...new Set(xs.filter(Boolean))];

/* An amplicon names one or more primers.csv designs (or an assays.csv panel),
   comma-separated — so a library is coloured by what it was trying to read,
   which is the same rule the qPCR tables are coloured by. */
function ampliconSpecies(amplicon) {
  const out = [];
  for (const name of String(amplicon || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const sp = (design(name)?.Species || "").trim();
    if (sp && !out.includes(sp)) out.push(sp);
  }
  return out;
}

/* ============================ stats ============================ */
function renderStats(wrap, app) {
  const results = app.state.rows["res-results"];
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
  lab.tubes = new Set((tables["cdna.csv"]?.rows || []).map(r => r.Tube).filter(Boolean));

  const unknown = new Map();
  for (const r of results.rows) {
    r.Species = assaySpecies(r.Primer, unknown).join(" + ");
    r.Instrument = instrumentOf(r.Channel);
    r.Source = uniq(pool(r.Sample).map(x => lab.source.get(x))).join(" + ");
  }

  const sequencing = tables["sequencing.csv"]?.rows || [];
  for (const r of sequencing) {
    r.Species = ampliconSpecies(r.Amplicon).join(" + ");
    r.Source = uniq(pool(r.Sample).map(x => lab.source.get(x))).join(" + ");
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

  // The App keys rows by tab id, which is qualified with the block they belong
  // to; in here they are just the files they were read from.
  return {
    rows: {
      "res-results": results.rows,
      "res-sequencing": sequencing,
    },
    notice,
  };
}

Dataview.group({
  id: "res",
  label: "Results",
  required: ["qPCR-results.csv"],
  views,
  tabs: [{ id: "res-stats", label: "Stats", render: renderStats }],
  ingest,
});

})();
