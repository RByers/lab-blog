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
        hasHue, hueOf, isWarm, statTable, link, extLink } = Dataview;

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

/* ============================ the curves behind a Cq ============================
   A Cq is a number read off an amplification curve, and the curve itself is in
   the instrument's own run file — which zpcr.rbyers.ca opens. `Run` names that
   file and `Experiment` names its folder, so the path qPCR-results.md defines
   reconstructs from the row alone (the year is the folder's own date prefix):

     experiments/<year>/<Experiment>/<Run>

   The app addresses a file by its *catalog* name, which for one read off disk
   is the granted folder's label followed by the path beneath it — so the link
   only resolves for someone who has granted `experiments/` and loaded the file
   there. That's the assumption this link is written under; on a miss the app
   selects nothing and shows the curves view empty, which is the honest answer
   rather than another run's curves. Nothing here leaks: a fragment never
   reaches the server, so the folder names stay in the reader's own browser.

   `wells=` narrows what that view draws to the one well the number was read
   off, rather than handing over a plate of ninety-six curves to hunt through.
   It's a selector over there (labels and ranges), and a single label is the
   whole of it here — one row is one well. The app applies it to the file
   `file=` names, so the same miss above is still just an empty view, and it
   writes into the file's own selection, so a click on the plate replaces it.

   `Well` is passed through as written rather than validated here, because the
   grammar it has to satisfy belongs to the app. A Biomeme well is a bare
   number (`1`..`9`) and no plate label at all; that names no well over there,
   and a selector naming no well is ignored, which lands back on the whole-file
   view this link used to give. Nothing to special-case.

   Both instruments' formats are supported over there (`.zpcr` and `.bmrun`
   alike), so this is not a CFX96-only link.

   The caveat qPCR-results.md gives applies: a plate that served two
   experiments is filed under one of them, so a row whose `Experiment` is the
   other one names a path that folder doesn't hold. `Experiment` is still the
   join key and the copy is usually in both folders; a link that misses is the
   same empty view as a file that was never loaded. */
const ZPCR_APP = "https://zpcr.rbyers.ca/";
function curvesUrl(row) {
  const exp = row.Experiment || "", run = row.Run || "", well = row.Well || "";
  if (!run || !/^\d{4}-/.test(exp)) return "";
  const file = `experiments/${exp.slice(0, 4)}/${exp}/${run}`;
  const hash = { file, view: "curves" };
  if (well) hash.wells = well;
  return ZPCR_APP + "#" + new URLSearchParams(hash);
}

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
  reagent: new Map(),     // lower-cased reagents.csv Label -> Label as written
  assay: new Map(),       // lower-cased assays.csv Name -> Name as written
  source: new Map(),      // samples.csv Label -> Source
  tubes: new Set(),       // cdna.csv Tube labels, so a submitted tube can link
};

/* `None` is not an assay: it is the sentinel for a channel nothing was aimed
   at, kept so the noise on an unused channel can be read next to the real one.
   It names no row anywhere, by design. */
const isNone = name => name.toLowerCase() === "none";

/* ====================== a name to the row that defines it ======================
   An assay name in this file names a row in the Inventory block, and which
   file that row is in is the whole nuance qPCR-results.md and assays.md spell
   out. `Primer` records the assay *as prepared*, so a reagents.csv tube is what
   it primarily names; the primers.csv design behind it is a level further down,
   and `assays.csv` holds the multi-tube panels and the sequencing schemes.
   `Amplicon` reads the other way round — a design, or a tiling panel.

   So the caller passes the order to look in, and the match is exact (folding
   case, which is all these four columns' spellings ever differ by). Nothing
   fuzzy: the prefix rule below is for finding a *design* behind a preparation,
   which is a different question from where this name is written down. */
const TABLES = {
  primers:  () => [lab.primer, "Label"],
  reagents: () => [lab.reagent, "Label"],
  assays:   () => [lab.assay, "Name"],
};

function defn(name, order) {
  const key = String(name || "").trim().toLowerCase();
  if (!key || isNone(key)) return null;
  for (const tab of order) {
    const [map, col] = TABLES[tab]();
    const hit = map.get(key);
    // primers.csv is kept as whole rows, the other two as just their label
    if (hit) return { tab: "inv-" + tab, file: tab + ".csv",
      spec: { [col]: [typeof hit === "string" ? hit : hit[col]] } };
  }
  return null;
}

// The same, already a link — or plain text where the name defines nothing, so
// an unlinked name reads as exactly that.
function defnLink(name, order, what) {
  const t = defn(name, order);
  if (!t) return document.createTextNode(name);
  return link(name, { tab: t.tab, spec: t.spec },
    `${Object.values(t.spec)[0][0]} in ${t.file} — ${what}`);
}

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

/* The organisms a well's assays are looking for — what colours the row. A name
   with no design behind it simply adds no colour, and that is not a fault: a
   2020 panel tube (`RVP1 ma`, `PIVP ri`, `DRVP ri`) covers several assays at
   once and deliberately has no primers.csv row, and a host gene (`B2M`, `RP`)
   has a design but no species. Both leave the row uncoloured, which is honest —
   what is worth reporting is a name that defines nothing anywhere, and ingest
   counts those separately. */
function assaySpecies(primer) {
  const out = [];
  for (const name of parts(primer)) {
    const sp = (design(name)?.Species || "").trim();
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
      // Off by default: it says nothing about the biology, and the one thing it
      // is good for — the curves — the Cq itself now links to.
      { k: "Run",      t: T.clip, off: true,
        title: "The instrument run file these numbers came off, inside the Experiment folder" },
      { k: "Species",  t: T.flag, title: "What this well's assays target, via primers.csv. Blank on a host gene, and on a panel tube covering several assays" },
      { k: "Primer",   t: T.flag, title: "The assay as it was prepared — a reagents.csv tube, or the primers.csv design where no tube carries the name" },
      { k: "Determination", t: T.flag, title: "The subjective call for this well/channel — expected to change as later experiments learn more" },
      { k: "Cq",       t: cqCol, title: "Quantification cycle; blank and 0.0 both mean no amplification was called. A called Cq opens its curve on zpcr.rbyers.ca" },
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
      /* A multiplexed well names several assays, and each of them is defined
         somewhere in the Inventory block — so each links to the row that
         defines it. Reagents first, because this column records the assay as it
         was *prepared*: `RVP1 ma` and `PIVP ri` are tubes covering several
         assays, whole records in reagents.csv with no primers.csv design to
         reach, and the click should land on the tube rather than nowhere.
         The other direction — every well an assay has been run in — is the link
         waiting on the far side, off the Label column of either tab. */
      if (c.k === "Primer" && val) {
        for (const p of parts(val)) {
          if (td.childNodes.length) td.append(" + ");
          td.append(defnLink(p, ["reagents", "primers", "assays"],
            "the assay this well was run with"));
        }
        return true;
      }
      // A called Cq opens the curve it was read off. commonCell draws the wells
      // with no Cq, and those get no link: there is a curve there too, but the
      // reason to go and look is the number, so an em dash stays an em dash.
      if (c.k === "Cq" && cq(val) !== null) {
        const url = curvesUrl(row);
        if (!url) return false;
        td.append(extLink(val, url,
          `The ${row.Well} curves in ${row.Run}, on zpcr.rbyers.ca`));
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
      /* An amplicon is what was read, so it names a design — or, for a tiling
         scheme (`Artic v3`, `RespiCoV` and its subpools), the assays.csv row
         that is the whole record of one. Designs first, the opposite of the
         qPCR tab: this column is written at the design level, not as a tube. */
      if (c.k === "Amplicon" && val) {
        for (const n of ampliconParts(val)) {
          if (td.childNodes.length) td.append(", ");
          td.append(defnLink(n, ["primers", "assays", "reagents"],
            "what was amplified"));
        }
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
const ampliconParts = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

function ampliconSpecies(amplicon) {
  const out = [];
  for (const name of ampliconParts(amplicon)) {
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

  // The two other places an assay name can be defined. Only the label is kept:
  // these tabs have their own rows, and all this block needs is what to link to.
  const labels = (file, col) => new Map((tables[file]?.rows || [])
    .map(r => (r[col] || "").trim()).filter(Boolean)
    .map(v => [v.toLowerCase(), v]));
  lab.reagent = labels("reagents.csv", "Label");
  lab.assay = labels("assays.csv", "Name");

  lab.source = new Map();
  for (const s of tables["samples.csv"]?.rows || []) {
    if (s.Label) lab.source.set(s.Label, s.Source || "");
  }
  lab.tubes = new Set((tables["cdna.csv"]?.rows || []).map(r => r.Tube).filter(Boolean));

  /* A name that defines nothing in any of the three files is the one thing
     worth reporting — a typo, or a tube that was never written down. Failing to
     match primers.csv is not: qPCR-results.md is explicit that `Primer` names
     the assay as prepared, so a reagents.csv tube is a complete answer, and the
     2020 panels (`RVP1 ma`, `PIVP ri`, `DRVP ri`) have no design row on
     purpose. This is the same resolution tools/check-data.py enforces. */
  const unknown = new Map();
  const seen = (name, order) => {
    if (!isNone(name) && !defn(name, order)) unknown.set(name, (unknown.get(name) || 0) + 1);
  };
  for (const r of results.rows) {
    r.Species = assaySpecies(r.Primer).join(" + ");
    r.Instrument = instrumentOf(r.Channel);
    r.Source = uniq(pool(r.Sample).map(x => lab.source.get(x))).join(" + ");
    for (const p of parts(r.Primer)) seen(p, ["reagents", "primers", "assays"]);
  }

  const sequencing = tables["sequencing.csv"]?.rows || [];
  for (const r of sequencing) {
    r.Species = ampliconSpecies(r.Amplicon).join(" + ");
    r.Source = uniq(pool(r.Sample).map(x => lab.source.get(x))).join(" + ");
    for (const n of ampliconParts(r.Amplicon)) seen(n, ["primers", "assays", "reagents"]);
  }

  /* A missing file is reported instead of what it would have resolved: with one
     of the three absent, every name it defines reads as unresolved, and that is
     the folder's state rather than a fault in the data. */
  const missing = ["primers.csv", "reagents.csv", "assays.csv"].filter(f => !tables[f]);
  let notice = "";
  if (missing.length) {
    notice = `No ${missing.join(" or ")} in that folder — assay names can't be `
      + `resolved to the row that defines them, so they aren't linked`
      + (tables["primers.csv"] ? "." : ", and rows can't be coloured by what the assay targets.");
  } else if (unknown.size) {
    const list = [...unknown.entries()].sort((a, b) => b[1] - a[1])
      .map(([n, c]) => c > 1 ? `${n} (${c})` : n).join(", ");
    const many = unknown.size > 1;
    notice = `${unknown.size} assay name${many ? "s" : ""} ${many ? "define" : "defines"} `
      + `nothing in primers.csv, reagents.csv or assays.csv, so `
      + `${many ? "they aren't" : "it isn't"} linked: ${list}`;
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
