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
   the order they were added in. */
function align(seqs, opts) {
  const s = seqs.map(normalize), n = s.length;
  if (!n) return { rows: [], order: [], scores: [] };
  const score = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      score[a][b] = score[b][a] = addToAlignment([s[a]], s[b], opts).score;

  let first = 0, top = -Infinity;
  for (let a = 0; a < n; a++) {
    const t = score[a].reduce((x, y) => x + y, 0);
    if (t > top) { top = t; first = a; }
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

/* ============================ the whole file ============================
   Records (CSV rows, or any objects) grouped by species, each group aligned
   and compared. Records with no sequence are left out, and a species with none
   left isn't a group. Groups come back largest first, then by name; members in
   the order they were given. Field names default to pathogens.csv's. */
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
    const aln = align(members.map(m => m.seq), opts.scoring);
    const cons = consensus(aln.rows);
    members.forEach((m, k) => {
      m.aligned = aln.rows[k];
      m.diff = compare(m.aligned, cons.seq);
    });
    // a column is variable when some row that covers it disagrees with the call
    const variable = [];
    for (let j = 0; j < cons.seq.length; j++)
      if (members.some(m => "x-+".includes(m.diff.states[j]))) variable.push(j);
    groups.push({
      species, members, order: aln.order,
      consensus: cons.seq, depth: cons.depth, support: cons.support,
      length: cons.seq.length, variable,
    });
  }
  return groups.sort((a, b) => b.members.length - a.members.length
    || a.species.localeCompare(b.species));
}

return {
  DEFAULTS, GAP,
  normalize, ungap, span, profile,
  addToAlignment, alignPair, align, consensus, compare, analyze,
};
});
