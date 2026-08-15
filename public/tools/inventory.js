/* inventory.js — the lab inventory browser.
 *
 * Samples, pathogens, species, cDNA tubes, primer designs and reagents, one tab
 * each, plus a computed per-person sampling-coverage tab. Everything generic —
 * reading the folder, sorting, filtering, hiding columns, the legend bar, the
 * address bar — lives in dataview.js; what's here is what makes this tool the
 * inventory: which columns each CSV shows, how samples join to pathogens, how
 * the cDNA ledger rolls up into tubes, how a row gets its colour, and the
 * cold-episode grouping.
 */
"use strict";

(() => {
const { T, esc, dnum, dateOnly, cmpLabel, hasHue, hueOf, isWarm, statTable,
        link, round } = Dataview;

// The other tool. Named once so a link to it is a link, not a string.
const RESULTS = "results.html";

/* ============================ derived state ============================
   Rebuilt from the CSVs on every ingest, and read by the view definitions
   below. Kept out of Dataview's state, which holds only what is generic. */
const lab = {
  byLabel: new Map(),     // sample label -> [pathogen rows]
  colds: new Map(),       // sample label -> cold-episode id
  coldSpan: new Map(),    // cold-episode id -> its newest date
  assaySpecies: new Map(),// primers.csv: lower-cased Label -> Species
  commensal: new Set(),   // species.csv: Species with Pathogenicity=Commensal
  events: new Map(),      // cdna.csv: tube -> its ledger rows, in file order
  hasCdna: new Set(),     // sample labels with at least one cDNA tube
  samples: new Set(),     // every samples.csv Label, for deciding what to link
};

/* Commensals are deliberately left uncoloured. A row's tint is there to say
   "something was found here", and finding a commensal isn't a finding — it's
   normal respiratory flora, and the YouSeq handbook expects recurring late
   amplification on those assays as background. Colouring them made a swab with
   nothing but carriage look like a hit. species.csv is what says which they
   are, so without that file loaded nothing is suppressed. */
const isCommensal = s => lab.commensal.has(s);

const splitSpecies = v => String(v || "").split(" + ").map(s => s.trim()).filter(Boolean);
const speciesOf = row => splitSpecies(row.Species);
// the badges still list everything found; only the tint drops commensals, so a
// swab whose sole hit is carriage reads as the blank row it is
const tintSpecies = row => speciesOf(row).filter(s => !isCommensal(s));
const isSequenced = row => !!(row.Sequenced || row.Seq);

/* ================== Confirmed+ → assay names → species ==================
   `Confirmed+` is free text but it has a grammar, documented in
   data/samples.md under "Confirmed+ as structured data" and parsed the same
   way by tools/check-data.py:

     ENT rc (28.1, 27.8, 89°, 88.5°), HRV Ma (30)   -> ENT rc, HRV Ma

   Split on commas *outside* parentheses (a Cq group can hold its own commas),
   drop the parenthesised numbers, and skip anything with a trailing `?` — that
   marks a call the experimenter didn't trust. A leading `~` (marginal) is
   stripped but the hit still counts. */
function assayNames(confirmed) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of confirmed || "") {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);

  const out = [];
  for (const p of parts) {
    const name = p.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (!name || name.endsWith("?")) continue;
    const bare = name.replace(/^~+/, "").trim();
    if (bare) out.push(bare);
  }
  return out;
}

// Species detected by this row's confirmed assays. Unresolvable names are
// collected so the page can say so rather than silently colouring nothing.
function confirmedSpecies(row, unknown) {
  const out = [];
  for (const name of assayNames(row["Confirmed+"])) {
    const sp = lab.assaySpecies.get(name.toLowerCase());
    if (sp === undefined) { unknown.set(name, (unknown.get(name) || 0) + 1); continue; }
    if (sp && !out.includes(sp)) out.push(sp);
  }
  return out;
}

/* ===================== cold episodes =====================
   `Cold` holds the label of the episode's primary sample, and every sample of
   that episode carries the same value — so the column *is* the episode id and
   there is nothing to infer. (This used to guess: same Source, within 14 days
   of the previous swab. That merged Rick's Dec 2023 Tokyo cold with the
   influenza he caught a week later, which is exactly why the column exists.)

   A sample with a blank `Cold` isn't part of a tracked episode; it gets a
   singleton id so it still sorts sensibly. */
function findColds(samples) {
  lab.colds = new Map();
  lab.coldSpan = new Map();
  for (const r of samples) {
    const id = (r.Cold || "").trim() || ("untracked:" + r.Label);
    lab.colds.set(r.Label, id);
    const t = dnum(r.Date);
    if (t === null) continue;
    const prev = lab.coldSpan.get(id);
    if (prev === undefined || t > prev) lab.coldSpan.set(id, t);
  }
}

// dir 0 on the samples Date column is the third click: group by cold episode
const coldSort = s => s.k === "Date" && s.dir === 0;

/* ============================ the legend ============================
   Species chips, shared by every table view — the colour key for the row
   tints, and a one-click filter. */
function speciesLegend(rows, app) {
  const counts = new Map(), seqCounts = new Map(), commensals = new Map();
  for (const r of app.state.rows[app.state.view]) {
    const seq = isSequenced(r);
    for (const s of speciesOf(r)) {
      // the legend is a colour key, and commensals have no colour — counting
      // them here would put a coloured chip against rows that stayed blank
      if (isCommensal(s)) { commensals.set(s, (commensals.get(s) || 0) + 1); continue; }
      counts.set(s, (counts.get(s) || 0) + 1);
      if (seq) seqCounts.set(s, (seqCounts.get(s) || 0) + 1);
    }
  }
  // reagents have no species at all; a view with nothing but commensals still
  // gets the bar, so the absence of colour is explained rather than mysterious
  if (!counts.size && !commensals.size) return null;

  // viruses first, then the bacteria and fungi as one tan block — sorting by
  // hue alone would file them in among the flu and RSV entries they sit next
  // to on the wheel, which is the adjacency the warm band exists to avoid
  const order = [...counts.entries()].sort((a, b) =>
    isWarm(a[0]) - isWarm(b[0]) || hueOf(a[0]) - hueOf(b[0]) || a[0].localeCompare(b[0]));
  const noun = app.state.view === "samples" ? "sample" : "record";

  const notes = [];
  if (counts.size) notes.push({
    html: '<span class="dk"></span> darker = sequenced', hue: 145,
  });
  // Name them rather than just leaving those rows blank: an uncoloured row with
  // a Species badge on it otherwise reads as a bug.
  if (commensals.size) {
    const list = [...commensals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    notes.push({
      html: "commensal, not coloured: " + esc(list.map(([s]) => s).join(", ")),
      title: list.map(([s, n]) => `${s} (${n})`).join(", "),
    });
  }

  return {
    label: "Species",
    chips: order.map(([s, n]) => ({
      key: s, count: n,
      sub: seqCounts.get(s) ? seqCounts.get(s) + "seq" : "",
      title: `${n} ${noun}${n > 1 ? "s" : ""}`
        + (seqCounts.get(s) ? `, ${seqCounts.get(s)} sequenced` : "") + " — click to filter",
    })),
    notes,
  };
}

// Every table view is coloured the same way, so the hooks are shared too.
const coloured = {
  tint: r => { const sp = tintSpecies(r); const s = sp.find(hasHue) || sp[0]; return s ? Dataview.tint(s) : null; },
  tints: r => tintSpecies(r),
  hi: isSequenced,
  legend: speciesLegend,
  chipCol: "Species",
  // A row can name several species, so "filtered to HRV-A" has to mean "names
  // HRV-A", not "is exactly HRV-A" — for a legend chip and for a link alike.
  match: { Species: (cell, want) => splitSpecies(cell).includes(want) },
  cell(td, c, row, val) {
    if (c.k === "Species" && val) {
      td.innerHTML = speciesOf(row).map(s => `<span class="badge">${esc(s)}</span>`).join(" ");
      return true;
    }
    return false;
  },
};

/* ============================ views ============================ */
const views = {
  samples: {
    label: "Samples",
    key: "Label",
    ...coloured,
    sort: { k: "Date", dir: 0 },      // grouped by cold episode
    cols: [
      { k: "Label",    t: T.label, title: "Links to this sample's cDNA tubes, where it has any" },
      { k: "Date",     t: T.date },
      { k: "Source",   t: T.narrow },
      { k: "Species",  t: T.flag },
      { k: "Type",     t: T.flag },
      { k: "Seq",      t: T.flag, off: true, title: "Sequencing run(s) this sample appears in" },
      { k: "Symptoms", t: T.clip },
      { k: "Prob",     t: T.num, title: "Subjective probability it's a real infection (0–10)" },
      { k: "Day",      t: T.num, title: "Day of illness when sampled" },
      { k: "Cold",     t: T.flag, title: "Label of the sample representing this illness episode (itself, if this is the primary)" },
      { k: "Confirmed+", t: T.clip },
      { k: "B2M",      t: T.num, title: "B2M host-control Cq" },
      { k: "Negative", t: T.clip, off: true },
      { k: "Sample",   t: T.clip, off: true },
      { k: "Extraction", t: T.clip, off: true },
      // samples.csv used to carry a cDNA date; the cDNA tab is what replaced it
      { k: "Raw?",     t: T.tick, off: true },
      { k: "Empty / Discarded", t: T.flag, off: true },
      { k: "Note",     t: T.clip },
    ],
    // the Date column leads with grouped-by-cold, then cycles ↓ → ↑
    nextSort(k, s) {
      if (k !== "Date") return null;
      if (s.k !== k) return { k, dir: 0 };
      return { k, dir: s.dir === 0 ? -1 : s.dir === -1 ? 1 : 0 };
    },
    sortHelp: k => k === "Date" ? "group each cold together, then sort by Date" : null,
    sortRows(rows, sort) {
      if (!coldSort(sort)) return null;
      // newest episode first, but oldest-to-newest *within* an episode so a
      // cold reads in the order it was swabbed
      return rows.slice().sort((a, b) => {
        const ca = lab.colds.get(a.Label), cb = lab.colds.get(b.Label);
        if (ca !== cb)
          return (lab.coldSpan.get(cb) ?? -Infinity) - (lab.coldSpan.get(ca) ?? -Infinity)
            || String(ca).localeCompare(String(cb));
        return (dnum(a.Date) ?? Infinity) - (dnum(b.Date) ?? Infinity)
          || cmpLabel(a.Label, b.Label);
      });
    },
    tbodyClass: s => coldSort(s) ? "cold" : "",
    decorate(tr, r, i, rows) {
      if ((r["Empty / Discarded"] || "").trim()) tr.classList.add("dim");
      // in cold order, a row followed by another swab from the same cold gets
      // a hairline instead of the full rule, and every swab of a multi-sample
      // cold gets a segment of the tie bar
      if (!coldSort(app.state.sort.samples)) return;
      const c = lab.colds.get(r.Label);
      const same = j => { const o = rows[j]; return o && c && lab.colds.get(o.Label) === c; };
      const up = same(i - 1), down = same(i + 1);
      if (down) tr.dataset.samecold = "";
      if (up || down) tr.dataset.cold = !up ? "first" : !down ? "last" : "mid";
    },
    cell(td, c, row, val) {
      // The three ways out of a sample row: its cDNA tubes (here), the qPCR
      // wells behind the call in Confirmed+, and the sequencing libraries.
      if (c.k === "Label" && lab.hasCdna.has(val)) {
        td.append(link(val, "", { tab: "cdna", spec: { Sample: [val] } },
          `cDNA tubes made from ${val}`));
        return true;
      }
      if (c.k === "Confirmed+" && val) {
        td.append(link(val, RESULTS, { tab: "results", spec: { Sample: [row.Label] } },
          `The qPCR wells this call was made from — every well ever run on ${row.Label}`));
        return true;
      }
      if (c.k === "Seq" && val) {
        td.append(link(val, RESULTS, { tab: "sequencing", spec: { Sample: [row.Label] } },
          `The sequencing libraries made from ${row.Label}`));
        return true;
      }
      if (c.k === "Cold") {
        // A tick for the episode's primary (Cold === Label), otherwise the
        // label of the primary this sample defers to.
        td.innerHTML = !val ? ""
          : val === row.Label ? '<span class="tick">✓</span>'
          : `<span class="badge">${esc(val)}</span>`;
        return true;
      }
      if (c.k === "Prob" && parseFloat(val) > 5 && !row.Species && !row["Confirmed+"]) {
        // high subjective probability of a real infection, nothing ever found
        td.className += " unexplained";
        td.title = "Looked like a real infection, but nothing was ever detected";
        td.textContent = val;
        return true;
      }
      return coloured.cell(td, c, row, val);
    },
  },

  pathogens: {
    label: "Pathogens",
    key: "Sample",
    ...coloured,
    sort: { k: "Date", dir: -1 },
    cols: [
      { k: "Sample",   t: T.label },
      { k: "Date",     t: T.date },
      { k: "Source",   t: T.flag },
      { k: "Species",  t: T.flag },
      { k: "Type",     t: T.flag },
      { k: "PCR Assay", t: T.flag },
      { k: "Sequenced", t: T.clip },
      { k: "Melt ENT rc", t: T.num, off: true },
      { k: "Melt HRV ma", t: T.num, off: true },
      { k: "Melt HRV bo", t: T.num, off: true },
      { k: "RefSeq",   t: T.flag },
      { k: "RefSeq Mismatches", t: T.num, off: true },
      { k: "RefSeq Identity", t: T.num },
      { k: "Closest",  t: T.flag },
      { k: "Closest Mismatches", t: T.num, off: true },
      { k: "Closest Identity", t: T.num },
      { k: "Location", t: T.clip },
      { k: "Sequence", t: T.seq, off: true },
      { k: "Notes",    t: T.clip, off: true },
    ],
    cell(td, c, row, val) {
      if (c.k === "Sample" && val) {
        td.append(link(val, "", { tab: "samples", spec: { Label: [val] } },
          `${val} in samples.csv`));
        return true;
      }
      // `Q2-NB03` is a sequencing.csv run and the barcode within it; the run is
      // the half that identifies a row over there.
      if (c.k === "Sequenced" && val) {
        const runs = [...new Set(val.split(/[\s,;·]+/).filter(Boolean)
          .map(t => t.split("-")[0]))];
        if (runs.length) {
          td.append(link(val, RESULTS, { tab: "sequencing", spec: { Run: runs } },
            `The sequencing ${runs.length > 1 ? "runs" : "run"} behind this: ${runs.join(", ")}`));
          return true;
        }
      }
      return coloured.cell(td, c, row, val);
    },
  },

  species: {
    label: "Species",
    key: "Species",
    ...coloured,
    sort: { k: "Species", dir: 1 },
    // Type is Virus / Bacteria / Fungus — "what kind of thing is this", not the
    // taxonomic rank of the name (see data/species.md). The column was called
    // Order until the file renamed it, for exactly that reason.
    group: { of: r => r.Type || "", label: k => k || "(no type)" },
    cols: [
      { k: "Species", t: T.flag, title: "The short label the rest of the repo joins on" },
      { k: "Name",    t: T.clip },
      { k: "Type",    t: T.flag, off: true },   // it's the group heading
      { k: "Pathogenicity", t: T.flag,
        title: "Commensal = part of a healthy respiratory microbiome, so a detection isn't by itself a finding" },
      { k: "Genome",  t: T.flag },
      { k: "RefSeq",  t: T.flag, off: true, title: "Reference genome, where the lab has settled on one" },
      { k: "Notes",   t: T.clip },
    ],
    cell(td, c, row, val) {
      if (c.k === "Species" && val) {
        td.append(link(val, "", { tab: "samples", spec: { Species: [val] } },
          `Samples this was found in`));
        return true;
      }
      return false;
    },
  },

  primers: {
    label: "Primers",
    key: "Label",
    ...coloured,
    sort: { k: "Label", dir: 1 },     // a reference table, not events
    cols: [
      { k: "Label",    t: T.label },
      { k: "Description", t: T.clip },
      { k: "Species",  t: T.flag },
      { k: "Type",     t: T.flag },
      { k: "Fwd Primer", t: T.seq },
      { k: "Fwd Tm",   t: T.num, off: true },
      { k: "Rev Primer", t: T.seq },
      { k: "Rev Tm",   t: T.num, off: true },
      { k: "Probe",    t: T.seq },
      { k: "Probe Tm", t: T.num, off: true },
      { k: "Product Tm", t: T.num, title: "Expected melt temperature of the product" },
      { k: "Length",   t: T.num, off: true, title: "Amplicon length (bp)" },
      { k: "Final concentration", t: T.flag, off: true },
      // spelled this way in the CSV; the header is the key, so it has to match
      { k: "Prob concentration", t: T.flag, off: true },
      { k: "Author",   t: T.flag, off: true },
      { k: "RefSeq",   t: T.flag, off: true },
      { k: "Position", t: T.flag, off: true },
      { k: "Probe Position", t: T.flag, off: true },
      { k: "Citation", t: T.clip },
      { k: "citationURL", t: T.url, off: true },
      { k: "Notes",    t: T.clip },
    ],
    cell(td, c, row, val) {
      // A design's roll-up over there: how often it has come up positive, its
      // usual Cq, its contamination history.
      if (c.k === "Label" && val) {
        td.append(link(val, RESULTS, { tab: "assays", spec: { Primer: [val] } },
          `Every qPCR assay prepared from the ${val} design`));
        return true;
      }
      return coloured.cell(td, c, row, val);
    },
  },

  reagents: {
    label: "Reagents",
    key: "Label",
    ...coloured,
    sort: { k: "Label", dir: 1 },
    // reagents are always grouped by what they are
    group: { of: r => r.Category || "", label: k => k || "(no category)" },
    cols: [
      { k: "Label",    t: T.label },
      { k: "Lid",      t: T.flag, title: "Cap colour — how a tube is found in a box" },
      { k: "Category", t: T.flag, off: true },   // it's the group heading
      { k: "Description", t: T.clip },
      { k: "Product",  t: T.clip },
      { k: "Location", t: T.narrow },
      { k: "Date aquired", t: T.date },
      { k: "Use by",   t: T.date, off: true },
      { k: "Notes",    t: T.clip },
    ],
    cell(td, c, row, val) {
      // qPCR names its assay as it was *prepared*, which is a reagent label —
      // so a primer tube here goes straight to the wells it was used in.
      if (c.k === "Label" && val && /primer|probe|assay/i.test(row.Category || "")) {
        td.append(link(val, RESULTS, { tab: "results", spec: { Primer: [val] } },
          `qPCR wells run with ${val}`));
        return true;
      }
      return coloured.cell(td, c, row, val);
    },
  },

  /* ---- cDNA ----
     `cdna.csv` is a ledger: one row per event, a create row per tube followed
     by a draw row per experiment that took volume out. What you want to see is
     the freezer — one line per tube, with what's left on it — so that is what
     this tab is, and the events behind a line are a twisty away. Nothing here
     stores a balance; `Left` is the sum of the tube's own rows, recomputed
     every ingest, which is the whole reason the file is shaped this way. */
  cdna: {
    label: "cDNA",
    key: "Tube",
    ...coloured,
    sort: { k: "Tube", dir: 1 },      // freezer order: tubes sit in sample order
    detail: {
      title: "Show the draws against this tube",
      empty: "no rows — this tube is only named by other rows",
      cols: [
        { k: "Date",       t: T.date },
        { k: "Experiment", t: T.clip },
        { k: "Volume",     t: T.num },
        { k: "Note",       t: T.clip },
      ],
      of: row => lab.events.get(row.Tube) || [],
      cell(td, c, ev, val) {
        if (c.k === "Experiment" && val && val !== "discarded") {
          td.append(link(val, RESULTS, { tab: "results", spec: { Experiment: [val] } },
            "The qPCR wells run in this experiment"));
          return true;
        }
        // signed µL: the create row puts volume in, every other row takes it out
        if (c.k === "Volume" && val) {
          td.textContent = (parseFloat(val) > 0 ? "+" : "") + val;
          td.title = parseFloat(val) > 0 ? "µL made" : "µL drawn";
          return true;
        }
        return false;
      },
    },
    cols: [
      { k: "Tube",     t: T.label, title: "As written on the tube: <sample> cD, a letter for a later batch, [-n] for a log₂ dilution" },
      { k: "Sample",   t: T.label, title: "The sample this cDNA was made from — off the tube label, except where it can't be" },
      { k: "Species",  t: T.flag, title: "What was found in that sample" },
      { k: "Left",     t: T.num, title: "µL remaining: the sum of this tube's rows. An upper bound, not a measurement — evaporation and unrecorded draws only push it down" },
      { k: "Made",     t: T.num, title: "µL the synthesis (or dilution) put in" },
      { k: "Draws",    t: T.num, title: "Experiments that have pipetted this tube" },
      { k: "Date",     t: T.date, title: "When it was made. Blank on the few tubes no note records making" },
      { k: "Last",     t: T.date, title: "The most recent event on this tube" },
      { k: "Dilution", t: T.flag, title: "Neat unless stated. 4x is the standard stored working aliquot; 16x and beyond are serial-dilution tubes" },
      { k: "Status",   t: T.flag, title: "empty = drawn to zero; discarded = cleared out of the freezer rather than pipetted" },
      { k: "Experiment", t: T.clip, off: true, title: "The experiment that made it" },
      { k: "Note",     t: T.clip, title: "From the create row: the RT enzyme, and any dilution" },
    ],
    decorate(tr, r) {
      if (r.Status) tr.classList.add("dim");     // nothing left to pipette
    },
    cell(td, c, row, val) {
      if (c.k === "Sample" && val) {
        // A pooled tube names its members with +, and each is a real sample.
        for (const s of val.split("+").map(x => x.trim()).filter(Boolean)) {
          if (td.childNodes.length) td.append("+");
          td.append(lab.samples.has(s)
            ? link(s, "", { tab: "samples", spec: { Label: [s] } }, `${s} in samples.csv`)
            : s);
        }
        return true;
      }
      return coloured.cell(td, c, row, val);
    },
  },
};

/* ====================== the cDNA ledger → tubes ======================
   One row out per tube, summed from the rows in. See data/cdna.md: a tube's
   first row is its create row and the rest are draws, `Volume` is signed, and
   the balance is deliberately nowhere in the file — it is this sum, so it can't
   drift out of step with the draws behind it. */

const µl = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/* Where the create row leaves `Sample` blank, the tube label is the sample:
   `S183 cD` → `S183`, `S108 cDc[-2]` → `S108`. The ~40 tubes that carry the
   column are the ones where that doesn't hold — pools, and tubes labelled for
   something other than their sample. */
const sampleOfTube = tube => String(tube).replace(/\s*cD.*$/i, "").trim();

/* The dilution factor is written in the create row's Note (`LunaScript, 4x`)
   and omitted when the tube is neat. The label's bracket says the same thing in
   log₂ — `[-2]` is 4× — so it's the fallback where the note didn't say. */
function dilutionOf(tube, note) {
  const m = /(?:^|[\s,;(])(\d+)\s*x\b/i.exec(note || "");
  if (m) return m[1] + "x";
  const b = /\[-(\d+)\]/.exec(tube);
  return b ? Math.pow(2, +b[1]) + "x" : "";
}

function cdnaRows(events, samples) {
  const bySample = new Map(samples.map(r => [r.Label, r]));
  return [...events].map(([tube, rows]) => {
    const create = rows[0];                        // a tube's first row
    const left = rows.reduce((a, r) => a + µl(r.Volume), 0);
    const made = rows.reduce((a, r) => a + Math.max(0, µl(r.Volume)), 0);
    const draws = rows.filter(r => µl(r.Volume) < 0);
    const sample = (create.Sample || sampleOfTube(tube)).trim();
    const members = sample.split("+").map(s => s.trim()).filter(Boolean);
    const of = f => [...new Set(members.flatMap(s => {
      const row = bySample.get(s);
      return row ? f(row) : [];
    }))].filter(Boolean);
    // The last thing that happened to it, which for most tubes is the last draw
    const last = rows.reduce((a, r) => (dnum(r.Date) ?? -Infinity) > (dnum(a.Date) ?? -Infinity) ? r : a, create);

    return {
      Tube: tube,
      Sample: sample,
      // Colour and the sequenced-darkening come from the sample the cDNA is
      // of, the same way every other tab in this tool is coloured.
      Species: of(r => speciesOf(r)).join(" + "),
      Seq: of(r => [r.Seq]).join(" · "),
      // Two decimals, because the draws have two — a 0.25µL well is a real
      // row, and rounding the sum to a tenth would make the balance disagree
      // with the numbers it was added up from.
      Left: round(left, 2),
      Made: round(made, 2),
      Draws: String(draws.length),
      Date: dateOnly(create.Date),
      Last: dateOnly(last.Date),
      Dilution: dilutionOf(tube, create.Note),
      // `discarded` is the file's one reserved Experiment: a tube thrown out
      // rather than pipetted. Everything else that reaches zero was used up.
      Status: rows.some(r => r.Experiment === "discarded") ? "discarded"
        : left <= 0 ? "empty" : "",
      Experiment: create.Experiment || "",
      Note: create.Note || "",
    };
  });
}

/* ============================ stats ============================
   Per-person coverage of the sampling programme. An illness episode is counted
   by its primary sample — the row where `Cold === Label`, hand-picked to
   represent the episode — so "confirmed" and "genotyped" are per cold, not per
   swab. Both are read straight off the pathogens.csv join (`Species`, `Type`)
   rather than from a flag in samples.csv, so they cannot go stale. */
const STAT_MIN = 5;      // sources with fewer samples than this fold into "Other"

function renderStats(wrap, app) {
  const samples = app.state.rows.samples;
  const n = new Map();
  for (const r of samples) n.set(r.Source || "—", (n.get(r.Source || "—") || 0) + 1);
  const main = [...n.entries()].filter(([, c]) => c >= STAT_MIN)
    .sort((a, b) => b[1] - a[1]).map(([s]) => s);

  const cols = ["Total", ...main, "Other"];
  const bucket = r => cols.includes(r.Source) ? r.Source : "Other";
  const count = f => {
    const out = Object.fromEntries(cols.map(c => [c, 0]));
    for (const r of samples) if (f(r)) { out.Total++; out[bucket(r)]++; }
    return out;
  };
  const year = r => Dataview.yearOf(r.Date);
  const primary = r => !!r.Cold && r.Cold === r.Label;

  const all     = count(() => true);
  const colds   = count(primary);
  const pcr     = count(r => primary(r) && !!r.Species);
  const gtype   = count(r => primary(r) && !!r.Type);
  const colds23 = count(r => primary(r) && year(r) >= 2023);
  const pcr23   = count(r => primary(r) && !!r.Species && year(r) >= 2023);
  const ratio = (a, b) => Object.fromEntries(cols.map(c => [c, b[c] ? a[c] / b[c] : null]));

  wrap.replaceChildren();
  wrap.insertAdjacentHTML("beforeend",
    `<h2>Sampling coverage</h2><p class="sub">One column per person who has given at least
     ${STAT_MIN} samples. A <b>cold</b> is an illness episode, counted by its
     primary sample (<code>Cold</code> = its own label); <b>confirmed</b> and <b>genotyped</b> are therefore
     rates per cold rather than per swab. Percentages shade from pale at 50% to solid at 100%.</p>`);
  wrap.append(statTable(cols, [
    { label: "Total samples", vals: all, tip: "Rows in samples.csv" },
    { label: "Likely separate colds", vals: colds, sep: true,
      tip: "Illness episodes — samples that are their own Cold (primary)" },
    { label: "PCR Confirmed", vals: pcr, tip: "Colds with a pathogens.csv row" },
    { label: "PCR Confirmed (%)", vals: ratio(pcr, colds), pct: true },
    { label: "PCR Confirmed (% 2023+)", vals: ratio(pcr23, colds23), pct: true,
      tip: "Same, restricted to colds from 2023 onwards" },
    { label: "Genotyped", vals: gtype, sep: true,
      tip: "Colds with a Type (genotype or lineage) in pathogens.csv" },
    { label: "Genotyped (% of PCR)", vals: ratio(gtype, pcr), pct: true },
    { label: "Genotyped (% of likely)", vals: ratio(gtype, colds), pct: true },
  ]));
}

/* ============================ ingest ============================ */
function ingest(tables) {
  const samples = tables["samples.csv"], pathogens = tables["pathogens.csv"];
  if (!samples.cols.includes("Label")) throw new Error("samples.csv has no Label column");
  if (!pathogens.cols.includes("Sample")) throw new Error("pathogens.csv has no Sample column");

  const rows = {
    samples: samples.rows,
    pathogens: pathogens.rows,
    species: tables["species.csv"]?.rows || [],
    primers: tables["primers.csv"]?.rows || [],
    reagents: tables["reagents.csv"]?.rows || [],
    cdna: [],                     // rolled up below, once samples are enriched
  };
  lab.samples = new Set(rows.samples.map(r => r.Label));

  lab.commensal = new Set(rows.species
    .filter(r => (r.Pathogenicity || "").trim() === "Commensal")
    .map(r => (r.Species || "").trim()));

  // assay name -> species it detects (lower-cased keys; spellings drift in case)
  lab.assaySpecies = new Map();
  for (const a of rows.primers) {
    const n = (a.Label || "").trim().toLowerCase();
    if (n) lab.assaySpecies.set(n, (a.Species || "").trim());
  }

  lab.byLabel = new Map();
  for (const r of rows.pathogens) {
    if (!lab.byLabel.has(r.Sample)) lab.byLabel.set(r.Sample, []);
    lab.byLabel.get(r.Sample).push(r);
  }

  // Fold pathogen info into the sample rows, then add anything `Confirmed+`
  // establishes that pathogens.csv doesn't. A sample can be a confirmed HRV
  // positive without a pathogens row of its own — most aren't primaries — and
  // those rows should still read as "something was found here".
  const unknownAssays = new Map();
  for (const r of rows.samples) {
    const hits = lab.byLabel.get(r.Label) || [];
    r.Type = hits.map(h => h.Type).filter(Boolean).join(" + ");
    r.Seq = hits.map(h => h.Sequenced).filter(Boolean).join(" · ").replace(/\n/g, " ");
    const all = hits.map(h => h.Species).filter(Boolean);
    for (const sp of confirmedSpecies(r, unknownAssays)) {
      // Don't add a species already covered by a more specific one: `ENT rc`
      // only establishes "HRV", which says nothing new next to pathogens.csv's
      // `HRV-C`. Same for RSV vs RSVA/RSVB.
      const low = sp.toLowerCase();
      if (!all.some(x => x.toLowerCase().startsWith(low))) all.push(sp);
    }
    r.Species = all.join(" + ");
  }
  findColds(rows.samples);

  // The cDNA ledger, gathered by tube. Done after the loop above, so a tube
  // inherits the species its sample ended up with rather than the bare
  // pathogens.csv join.
  lab.events = new Map();
  for (const r of tables["cdna.csv"]?.rows || []) {
    if (!r.Tube) continue;
    if (!lab.events.has(r.Tube)) lab.events.set(r.Tube, []);
    lab.events.get(r.Tube).push(r);
  }
  rows.cdna = cdnaRows(lab.events, rows.samples);
  lab.hasCdna = new Set(rows.cdna.flatMap(r => r.Sample.split("+").map(s => s.trim())));

  // Say so rather than quietly leaving those rows uncoloured.
  let notice = "";
  if (!tables["primers.csv"]) {
    notice = "No primers.csv in that folder — rows are coloured from pathogens.csv only.";
  } else if (unknownAssays.size) {
    const list = [...unknownAssays.entries()]
      .sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(", ");
    notice = `Confirmed+ names ${unknownAssays.size} assay${unknownAssays.size > 1 ? "s" : ""} `
      + `not in primers.csv: ${list}`;
  }
  return { rows, notice };
}

const app = new Dataview.App({
  title: "Inventory",
  prefsKey: "molbiolab.inventory.v5",
  required: ["samples.csv", "pathogens.csv"],
  landing: "Pick the folder holding <code>samples.csv</code> and <code>pathogens.csv</code> "
    + "(plus <code>primers.csv</code> for result colouring, and <code>species.csv</code> / "
    + "<code>reagents.csv</code> / <code>cdna.csv</code> for those tabs) — the repo root or its "
    + "<code>data/</code> folder both work. Nothing leaves this machine; the page only reads the files.",
  views,
  tabs: [{ id: "stats", label: "Stats", render: renderStats }],
  ingest,
});
app.start();

})();
