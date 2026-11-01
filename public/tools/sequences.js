/* sequences.js — the alignment behind the data tool's Sequences tab, with no
 * DOM in it, so the same file runs in the page and under node.
 *
 * `pathogens.csv` holds a consensus sequence per sequenced sample, and the
 * question worth asking of them is how the samples of one species differ from
 * each other. So: group the rows by their declared `Species`, align each
 * group's sequences into one multiple alignment, take the majority consensus
 * of that, and say where each sequence departs from it.
 *
 * The sequences are a few hundred bases and a group is a dozen of them, so the
 * simplest thing that gives a sensible answer is enough:
 *
 *  - Alignment is progressive. Every pair is scored, the sequence closest to
 *    all the others goes first, and the rest join one at a time, most similar
 *    first, each aligned against the *profile* of everything already placed
 *    (column base frequencies) rather than against one sequence of it.
 *  - Gaps are linear, not affine. Scores: match +2, mismatch −3, gap −5.
 *  - End gaps are free, on both sides. These are overlapping amplicons trimmed
 *    to slightly different lengths — one row in the file still carries its
 *    primers — so a sequence that starts late or runs long is expected, and
 *    its overhang shouldn't be forced into the middle to avoid a penalty. It's
 *    "semi-global" alignment: every base of every sequence is kept (a local
 *    Smith–Waterman alignment would clip the ends), but only the overlap is
 *    scored.
 *
 * The same rule decides what counts as a difference. A gap *before a
 * sequence's first base or after its last* is not a deletion, it is just where
 * that read stops: it doesn't vote in the consensus and isn't reported. A gap
 * between two of its bases is.
 *
 * Loaded as a classic script (like dataview.js, so the page still works off
 * file://), it defines a global `Sequences`; under node it is also
 * `module.exports`, and importing it from an ES module works through the
 * global:  import "./sequences.js"; const { analyze } = globalThis.Sequences;
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.Sequences = api;
})(globalThis, function () {
"use strict";

const GAP = "-";
const BASES = "ACGT";
// index into a profile column's scores; N is last and scores 0 against anything
const CODE = { A: 0, C: 1, G: 2, T: 3, N: 4 };

const DEFAULTS = { match: 2, mismatch: -3, gap: -5 };
const scoring = opts => ({ ...DEFAULTS, ...(opts || {}) });

/* Uppercase, no whitespace or digits, RNA read as DNA, and anything that isn't
   A/C/G/T (IUPAC ambiguity codes) as N — which matches everything at zero
   cost and never votes in a consensus. */
function normalize(seq) {
  return String(seq ?? "").toUpperCase().replace(/[^A-Z]/g, "")
    .replace(/U/g, "T").replace(/[^ACGT]/g, "N");
}

const ungap = row => row.split(GAP).join("");

/* The columns an aligned row actually covers: its first and last base, as
   [first, last], or null for a row that is all gap. Outside it is overhang. */
function span(row) {
  let a = 0, b = row.length - 1;
  while (a <= b && row[a] === GAP) a++;
  while (b >= a && row[b] === GAP) b--;
  return a > b ? null : [a, b];
}
const covers = (s, j) => s !== null && j >= s[0] && j <= s[1];

/* ============================ profile ============================
   An alignment seen as a column-by-column summary, which is what the next
   sequence is aligned against. Only rows that cover a column count in it. For
   each column: the average score of placing each base there (A, C, G, T, N),
   and the average cost of placing a gap there instead. A gap opposite a gap
   costs nothing, so a column most rows already skip is cheap to skip again. */
function profile(rows, sc) {
  const L = rows.length ? rows[0].length : 0;
  const spans = rows.map(span);
  const base = new Float64Array(L * 5), gap = new Float64Array(L);
  for (let j = 0; j < L; j++) {
    const cnt = { A: 0, C: 0, G: 0, T: 0, N: 0, [GAP]: 0 };
    let n = 0;
    for (let k = 0; k < rows.length; k++) {
      if (!covers(spans[k], j)) continue;
      cnt[rows[k][j]]++;
      n++;
    }
    if (!n) continue;
    for (const b of BASES) {
      let s = cnt[GAP] * sc.gap;
      for (const x of BASES) s += cnt[x] * (b === x ? sc.match : sc.mismatch);
      base[j * 5 + CODE[b]] = s / n;
    }
    // N stays 0
    gap[j] = sc.gap * (n - cnt[GAP]) / n;
  }
  return { L, base, gap };
}

/* ============================ one step ============================
   Align `seq` (ungapped) to the alignment `rows` and return the grown
   alignment with `seq`'s row last. Dynamic programming over (base of seq) ×
   (column of profile), with the first row and column free (end gaps) and the
   best score read off the last row or column (the other ends).

   Three moves per cell, kept in `tr`:
     DIAG  seq's base goes into this column
     LEFT  this column gets a gap in seq
     UP    seq's base goes into a new column, gapped in every existing row
   Ties go DIAG, then LEFT, then UP, so the result is deterministic. */
const DIAG = 1, LEFT = 2, UP = 3;

function addToAlignment(rows, seq, opts) {
  const sc = scoring(opts);
  if (!rows.length) return { rows: [seq], score: 0 };
  const { L, base, gap } = profile(rows, sc);
  const m = seq.length, W = L + 1;
  const tr = new Uint8Array((m + 1) * W);
  let prev = new Float64Array(W), cur = new Float64Array(W);
  for (let j = 1; j <= L; j++) tr[j] = LEFT;

  // Best place to stop: the last column (seq runs on past the profile) or the
  // last row (the profile runs on past seq). Starting at (m, L) — both used up.
  let best = -Infinity, bi = m, bj = L;
  for (let i = 1; i <= m; i++) {
    cur[0] = 0;
    tr[i * W] = UP;
    const b = CODE[seq[i - 1]] ?? CODE.N;
    for (let j = 1; j <= L; j++) {
      const d = prev[j - 1] + base[(j - 1) * 5 + b];
      const l = cur[j - 1] + gap[j - 1];
      const u = prev[j] + sc.gap;
      let s = d, t = DIAG;
      if (l > s) { s = l; t = LEFT; }
      if (u > s) { s = u; t = UP; }
      cur[j] = s;
      tr[i * W + j] = t;
    }
    if (cur[L] > best) { best = cur[L]; bi = i; bj = L; }
    [prev, cur] = [cur, prev];
  }
  // prev is now row m (or row 0 when seq is empty)
  for (let j = 0; j <= L; j++) if (prev[j] > best) { best = prev[j]; bi = m; bj = j; }

  // Walk back from the stopping point, then add the free overhang at each end.
  const ops = [];
  for (let j = L; j > bj; j--) ops.push(LEFT);
  for (let i = m; i > bi; i--) ops.push(UP);
  let i = bi, j = bj;
  while (i > 0 || j > 0) {
    const t = tr[i * W + j];
    ops.push(t);
    if (t !== LEFT) i--;
    if (t !== UP) j--;
  }
  ops.reverse();

  const out = rows.map(() => []), row = [];
  i = 0; j = 0;
  for (const t of ops) {
    if (t === UP) {
      for (const o of out) o.push(GAP);
      row.push(seq[i++]);
    } else {
      for (let k = 0; k < rows.length; k++) out[k].push(rows[k][j]);
      row.push(t === DIAG ? seq[i++] : GAP);
      j++;
    }
  }
  return { rows: [...out, row].map(r => r.join("")), score: best };
}

// Two sequences, aligned the same way.
function alignPair(a, b, opts) {
  return addToAlignment([normalize(a)], normalize(b), opts);
}

/* ============================ all of them ============================
   Every pair is scored first, and those scores are the guide: start from the
   sequence with the highest total against everything else, then repeatedly
   add whichever remaining sequence scores best against one already placed.
   Rows come back in the order the sequences were given, with `order` saying
   the order they were added in. `first`, when given, is the index to start
   from instead: a reference, which everything else is then laid against. */
function align(seqs, opts, first) {
  const s = seqs.map(normalize), n = s.length;
  if (!n) return { rows: [], order: [], scores: [] };
  const score = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      score[a][b] = score[b][a] = addToAlignment([s[a]], s[b], opts).score;

  if (!(first >= 0 && first < n)) {
    let top = -Infinity;
    first = 0;
    for (let a = 0; a < n; a++) {
      const t = score[a].reduce((x, y) => x + y, 0);
      if (t > top) { top = t; first = a; }
    }
  }
  const order = [first], placed = new Set(order);
  let rows = [s[first]];
  while (order.length < n) {
    let next = -1, nb = -Infinity;
    for (let a = 0; a < n; a++) {
      if (placed.has(a)) continue;
      for (const b of order) if (score[a][b] > nb) { nb = score[a][b]; next = a; }
    }
    rows = addToAlignment(rows, s[next], opts).rows;
    order.push(next);
    placed.add(next);
  }
  const byInput = new Array(n);
  order.forEach((a, k) => { byInput[a] = rows[k]; });
  return { rows: byInput, order, scores: score };
}

/* ============================ consensus ============================
   Per column, the majority among the rows that cover it — a base, or a gap
   when most of them skip it. Ties go to a base over a gap, then A < C < G < T.
   An N doesn't vote; a column with only Ns in it is N. `depth` is how many
   rows cover each column and `support` how many of them agree with the call,
   which is what says how much to trust a column near the ends. */
const VOTE = [...BASES, GAP];

function consensus(rows) {
  const L = rows.length ? rows[0].length : 0;
  const spans = rows.map(span);
  let seq = "";
  const depth = [], support = [];
  for (let j = 0; j < L; j++) {
    const cnt = { A: 0, C: 0, G: 0, T: 0, [GAP]: 0 };
    let d = 0;
    for (let k = 0; k < rows.length; k++) {
      if (!covers(spans[k], j)) continue;
      d++;
      if (rows[k][j] in cnt) cnt[rows[k][j]]++;
    }
    let call = "N", c = 0;
    for (const v of VOTE) if (cnt[v] > c) { c = cnt[v]; call = v; }
    seq += d ? call : GAP;
    depth.push(d);
    support.push(c);
  }
  return { seq, depth, support };
}

/* ============================ differences ============================
   One aligned row against the consensus, column by column:
     " "  outside the row's span — the read hasn't started, or has stopped
     "="  same base as the consensus
     "x"  a different base: a substitution
     "-"  a gap where the consensus has a base: a deletion
     "+"  a base where the consensus has a gap: an insertion
     "."  a gap where the consensus has one too
     "n"  an N in the row, or under an N in the consensus: no call either way
   `identity` is matches over every column that is a base in at least one of
   the two, inside the row's span. */
function compare(row, cons) {
  const s = span(row);
  let states = "";
  const n = { same: 0, subs: 0, dels: 0, ins: 0, unknown: 0 };
  for (let j = 0; j < row.length; j++) {
    const r = row[j], c = cons[j];
    let st;
    if (!covers(s, j)) st = " ";
    else if (r === GAP) st = c === GAP ? "." : "-";
    else if (c === GAP) st = "+";
    else if (r === "N" || c === "N") st = "n";
    else st = r === c ? "=" : "x";
    states += st;
    if (st === "=") n.same++;
    else if (st === "x") n.subs++;
    else if (st === "-") n.dels++;
    else if (st === "+") n.ins++;
    else if (st === "n") n.unknown++;
  }
  const scored = n.same + n.subs + n.dels + n.ins;
  return { states, span: s, ...n, identity: scored ? n.same / scored : null };
}

/* ============================ a reference ============================
   A species can have a reference genome, and its samples read best against
   that: one fixed sequence they are all compared to, with coordinates that
   mean something, rather than a consensus that moves whenever a sample is
   added. The reference is a whole genome, though, and the samples are one
   amplicon of it, so before it can be a row of the alignment it is cut down to
   that amplicon.

   The amplicon is found from the primers, not from coordinates recorded beside
   them: primers.csv quotes its positions against its own choice of accession,
   which isn't always the species', while a primer can simply be looked for.
   Primers are written 5'→3' with IUPAC ambiguity codes, so a forward primer
   reads on the reference's strand and a reverse primer on its complement. */
const IUPAC = {
  A: "A", C: "C", G: "G", T: "T",
  R: "AG", Y: "CT", S: "CG", W: "AT", K: "GT", M: "AC",
  B: "CGT", D: "AGT", H: "ACT", V: "ACG", N: "ACGT",
};
const COMP = {
  A: "T", C: "G", G: "C", T: "A", R: "Y", Y: "R", S: "S", W: "W",
  K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", N: "N",
};
// An oligo as written, uppercase, keeping its ambiguity codes.
const oligo = s => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "")
  .replace(/U/g, "T").replace(/[^ACGTRYSWKMBDHVN]/g, "N");
const revcomp = s => [...oligo(s)].reverse().map(c => COMP[c]).join("");
// each code as a bit per base it allows, so "could these be the same" is a &
const MASK = {};
for (const [c, bases] of Object.entries(IUPAC))
  MASK[c] = [...bases].reduce((m, b) => m | 1 << BASES.indexOf(b), 0);
const masks = s => Uint8Array.from(s, c => MASK[c] ?? 15);

/* Every place an oligo sits on `ref` with at most `maxMis` differences, on
   either strand, fewest first. A difference is a mismatched base, a base the
   reference has that the oligo doesn't, or one it lacks: an oligo against a
   reference with one extra base in the middle is one difference, where
   matching base-for-base would slide half of it along and count several.
   It's edit distance with the reference's ends free (Sellers' algorithm).

   { start, end, strand, mismatches, subs, extra, missing, mis, gaps }: `end`
   exclusive, `mismatches` the total, `mis` the reference positions that are
   wrong (a substituted base, or an extra one) and `gaps` the positions an
   oligo base is missing before. */
function findOligo(ref, probe, maxMis = 3) {
  const o = oligo(probe), hits = [];
  if (o.length < 8) return hits;
  const r = masks(ref), L = r.length, W = L + 1;
  for (const [strand, s] of [[1, o], [-1, revcomp(o)]]) {
    const q = masks(s), m = q.length;
    const D = new Uint8Array((m + 1) * W);           // row 0 is all 0: start anywhere
    for (let i = 1; i <= m; i++) {
      const row = i * W, up = row - W;
      D[row] = i;
      for (let j = 1; j <= L; j++)
        D[row + j] = Math.min(D[up + j - 1] + (q[i - 1] & r[j - 1] ? 0 : 1),
          D[up + j] + 1, D[row + j - 1] + 1);
    }
    // ends: each run of good-enough end points, at its best
    const last = m * W;
    for (let e = 1; e <= L; e++) {
      const v = D[last + e];
      if (v > maxMis || D[last + e - 1] <= v || (e < L && D[last + e + 1] < v)) continue;
      // back to where it starts, preferring a match, then a missing base
      const mis = [], gaps = [];
      let i = m, j = e, subs = 0, extra = 0, missing = 0;
      while (i > 0) {
        const here = D[i * W + j], ok = j > 0 && (q[i - 1] & r[j - 1]);
        if (j > 0 && here === D[(i - 1) * W + j - 1] + (ok ? 0 : 1)) {
          if (!ok) { mis.push(j - 1); subs++; }
          i--; j--;
        } else if (here === D[(i - 1) * W + j] + 1) { gaps.push(j); missing++; i--; }
        else { mis.push(j - 1); extra++; j--; }
      }
      hits.push({ start: j, end: e, strand, mismatches: v, subs, extra, missing,
        mis: mis.reverse(), gaps: gaps.reverse() });
    }
  }
  return hits.sort((a, b) => a.mismatches - b.mismatches || a.start - b.start);
}

/* Where a design ({ fwd, rev, probe }) puts its amplicon on `ref`: a forward
   and a reverse primer facing each other at most `maxLength` apart, the pair
   with the fewest mismatches and then the shortest — either way round, since a
   reference can run against the assay. The probe is looked for inside it.
   { start, end, fwd, rev, probe } in reference coordinates, or null. */
function placeAssay(ref, design, opts = {}) {
  const maxMis = opts.maxMismatches ?? 3, maxLen = opts.maxLength ?? 3000;
  // the best few dozen of each is plenty; a short degenerate primer can
  // otherwise land in hundreds of places, and every pair would be tried
  const F = findOligo(ref, design.fwd, maxMis).slice(0, 40);
  const R = findOligo(ref, design.rev, maxMis).slice(0, 40);
  let best = null;
  for (const f of F) for (const r of R) {
    if (f.strand === r.strand) continue;
    const [a, b] = f.strand === 1 ? [f, r] : [r, f];     // a on the left
    if (b.start < a.end || b.end - a.start > maxLen) continue;
    const mis = f.mismatches + r.mismatches, len = b.end - a.start;
    if (!best || mis < best.mis || (mis === best.mis && len < best.end - best.start))
      best = { start: a.start, end: b.end, inner: [a.end, b.start], fwd: f, rev: r, mis };
  }
  if (!best) return null;
  let probe = null;
  if (oligo(design.probe)) {
    const hit = findOligo(ref.slice(best.start, best.end), design.probe, maxMis)[0];
    if (hit) probe = { ...hit, start: hit.start + best.start, end: hit.end + best.start,
      mis: hit.mis.map(p => p + best.start), gaps: hit.gaps.map(p => p + best.start) };
  }
  return { start: best.start, end: best.end, inner: best.inner,
    fwd: best.fwd, rev: best.rev, probe };
}

/* Where a sequence sits on `ref`, as [start, end) in reference coordinates —
   the same semi-global alignment, so the rest of the genome is free overhang. */
function locate(ref, seq, opts) {
  const { rows } = addToAlignment([ref], normalize(seq), opts);
  const s = span(rows[1]);
  if (!s) return null;
  let pos = 0, start = 0, end = 0;
  for (let j = 0; j <= s[1]; j++) {
    if (j === s[0]) start = pos;
    if (rows[0][j] !== GAP) pos++;
  }
  end = pos;
  return [start, end];
}

/* Which design the sequences came from: the one whose amplicon *between* its
   primers (pathogens.csv's sequences are primer-trimmed) best matches where
   each sequence sits — overlap over union, averaged over the sequences. Null
   when none matches them by half. */
function chooseAssay(ref, spans, designs, opts) {
  let best = null;
  for (const d of designs || []) {
    const at = placeAssay(ref, d, opts);
    if (!at) continue;
    const [lo, hi] = at.inner;
    let fit = 0;
    for (const [a, b] of spans) {
      const over = Math.min(b, hi) - Math.max(a, lo);
      if (over > 0) fit += over / (Math.max(b, hi) - Math.min(a, lo));
    }
    fit /= spans.length || 1;
    if (fit >= 0.5 && (!best || fit > best.fit)) best = { design: d, ...at, fit };
  }
  return best;
}

/* ============================ the whole file ============================
   Records (CSV rows, or any objects) grouped by species, each group aligned
   and compared. Records with no sequence are left out, and a species with none
   left isn't a group. Groups come back largest first, then by name; members in
   the order they were given. Field names default to pathogens.csv's.

   `opts.reference(species)` may give a group its reference, as { accession,
   seq, designs } — the genome, and the primer designs its samples might have
   come from — and the group is then compared to that. Without one, it is
   compared to its own majority consensus. */
function analyze(records, opts = {}) {
  const f = { species: "Species", label: "Sample", sequence: "Sequence", ...opts.fields };
  const bySpecies = new Map();
  for (const rec of records || []) {
    const seq = normalize(rec[f.sequence]);
    if (!seq) continue;
    const sp = String(rec[f.species] ?? "").trim() || "(no species)";
    if (!bySpecies.has(sp)) bySpecies.set(sp, []);
    bySpecies.get(sp).push({ label: String(rec[f.label] ?? ""), record: rec, seq });
  }
  const groups = [];
  for (const [species, members] of bySpecies) {
    const ref = opts.reference?.(species);
    groups.push(ref && normalize(ref.seq) ? againstReference(species, members, ref, opts)
      : againstConsensus(species, members, opts));
  }
  return groups.sort((a, b) => b.members.length - a.members.length
    || a.species.localeCompare(b.species));
}

// a column is variable when some row that covers it disagrees with the call
function variableColumns(members, L) {
  const out = [];
  for (let j = 0; j < L; j++)
    if (members.some(m => "x-+".includes(m.diff.states[j]))) out.push(j);
  return out;
}

function againstConsensus(species, members, opts) {
  const aln = align(members.map(m => m.seq), opts.scoring);
  const cons = consensus(aln.rows);
  members.forEach((m, k) => {
    m.aligned = aln.rows[k];
    m.diff = compare(m.aligned, cons.seq);
  });
  return {
    species, members, order: aln.order,
    consensus: cons.seq, depth: cons.depth, support: cons.support,
    length: cons.seq.length, variable: variableColumns(members, cons.seq.length),
  };
}

/* The reference is cut to the amplicon of the design the samples fit, primers
   included, and further wherever a sample runs past that; it goes into the
   alignment first and every sample is compared to it. `position` is the
   reference's own numbering (1-based, as GenBank's) at each column, null where
   a sample has an insertion; `features` are the primers and probe, each with
   the columns it spans. */
function againstReference(species, members, ref, opts) {
  const genome = normalize(ref.seq);
  // The longest sequence is placed on the whole genome; the rest only need
  // looking for near it, which on a 30 kb genome is most of the time saved.
  const longest = members.reduce((a, m) => m.seq.length > a.seq.length ? m : a);
  const at = locate(genome, longest.seq, opts.scoring);
  const w0 = Math.max(0, at[0] - 1000), w1 = Math.min(genome.length, at[1] + 1000);
  const near = genome.slice(w0, w1);
  const spans = members.map(m => m === longest ? at
    : locate(near, m.seq, opts.scoring)?.map(p => p + w0)).filter(Boolean);
  const assay = chooseAssay(genome, spans, ref.designs, opts);
  let start = Math.min(...spans.map(s => s[0])), end = Math.max(...spans.map(s => s[1]));
  if (assay) { start = Math.min(start, assay.start); end = Math.max(end, assay.end); }

  const aln = align([genome.slice(start, end), ...members.map(m => m.seq)], opts.scoring, 0);
  const row = aln.rows[0];
  members.forEach((m, k) => {
    m.aligned = aln.rows[k + 1];
    m.diff = compare(m.aligned, row);
  });

  const position = [], column = new Map();
  for (let j = 0, p = start; j < row.length; j++) {
    if (row[j] === GAP) { position.push(null); continue; }
    column.set(p, j);
    position.push(++p);
  }
  const features = [];
  if (assay) for (const [kind, hit] of [["fwd", assay.fwd], ["rev", assay.rev], ["probe", assay.probe]]) {
    if (!hit) continue;
    features.push({ kind, start: hit.start, end: hit.end, strand: hit.strand,
      mismatches: hit.mismatches, subs: hit.subs, extra: hit.extra, missing: hit.missing,
      cols: [column.get(hit.start), column.get(hit.end - 1)],
      misCols: hit.mis.map(p => column.get(p)),
      gapCols: hit.gaps.map(p => column.get(p)).filter(j => j !== undefined) });
  }
  return {
    species, members, order: aln.order.slice(1).map(k => k - 1),
    reference: { accession: ref.accession, row, start, end, position, features,
      assay: assay ? assay.design : null },
    length: row.length, variable: variableColumns(members, row.length),
  };
}

return {
  DEFAULTS, GAP,
  normalize, ungap, span, profile,
  addToAlignment, alignPair, align, consensus, compare, analyze,
  oligo, revcomp, findOligo, placeAssay, locate, chooseAssay,
};
});
