// Tests for public/tools/sequences.js — run with `npm test`.
//
// The sequences are made up: the lab's own are in a private repository, and
// these only need to be long enough that the right alignment is unambiguous.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/tools/sequences.js";

const S = globalThis.Sequences;

// A 60 bp stretch with no repeats to slip on, and a second unrelated one.
const A = "ATGGCGTACCTAGGTCAAGTTCGAGCATGCTTAGCCGATACGGTACTTGACCAGTCGATC";
const B = "GGATCCTTAGCAAGTCCGTAGCTAAGCTTCGGATACCGTAGGCTTAACGTTCGACTGCAA";

// Every aligned row is the same length, and ungapped gives back its input.
function wellFormed(rows, inputs) {
  const L = rows[0].length;
  for (const r of rows) assert.equal(r.length, L);
  rows.forEach((r, k) => assert.equal(S.ungap(r), S.normalize(inputs[k])));
}

const sub = (s, i, b) => s.slice(0, i) + b + s.slice(i + 1);

test("normalize: case, whitespace, RNA and ambiguity codes", () => {
  assert.equal(S.normalize(" acg t\nAC"), "ACGTAC");
  assert.equal(S.normalize("ACGU"), "ACGT");
  assert.equal(S.normalize("ACRYNGT"), "ACNNNGT");
  assert.equal(S.normalize("12 ACG-T"), "ACGT");
  assert.equal(S.normalize(undefined), "");
});

test("span ignores leading and trailing gaps", () => {
  assert.deepEqual(S.span("--AC-G--"), [2, 5]);
  assert.deepEqual(S.span("ACG"), [0, 2]);
  assert.equal(S.span("---"), null);
  assert.equal(S.span(""), null);
});

test("alignPair: identical sequences align without gaps", () => {
  const { rows, score } = S.alignPair(A, A.toLowerCase());
  assert.deepEqual(rows, [A, A]);
  assert.equal(score, A.length * S.DEFAULTS.match);
});

test("alignPair: a substitution is a mismatch, not a pair of gaps", () => {
  const { rows } = S.alignPair(A, sub(A, 30, "T"));
  assert.deepEqual(rows, [A, sub(A, 30, "T")]);
});

test("alignPair: a deletion opens a gap in the middle", () => {
  const del = A.slice(0, 25) + A.slice(28);
  const { rows } = S.alignPair(A, del);
  wellFormed(rows, [A, del]);
  assert.equal(rows[0], A);
  assert.equal(rows[1].replace(/[^-]/g, "").length, 3);
  assert.deepEqual(S.span(rows[1]), [0, A.length - 1]);   // the gap is internal
});

test("alignPair: overlapping reads are offset, with free end gaps", () => {
  const left = A.slice(0, 45), right = A.slice(15);
  const { rows, score } = S.alignPair(left, right);
  assert.deepEqual(rows, [left + "-".repeat(15), "-".repeat(15) + right]);
  assert.equal(score, 30 * S.DEFAULTS.match);             // only the overlap scores
});

test("alignPair: a read carrying its primers contains the trimmed one", () => {
  const primed = "CAAGCACTTCTG" + A + "GGTACC";
  const { rows } = S.alignPair(primed, A);
  assert.deepEqual(rows, [primed, "-".repeat(12) + A + "-".repeat(6)]);
});

test("alignPair: empty sequences", () => {
  assert.deepEqual(S.alignPair(A, "").rows, [A, "-".repeat(A.length)]);
  assert.deepEqual(S.alignPair("", A).rows, ["-".repeat(A.length), A]);
  assert.deepEqual(S.alignPair("", "").rows, ["", ""]);
});

test("align: nothing, and one sequence", () => {
  assert.deepEqual(S.align([]).rows, []);
  assert.deepEqual(S.align(["acgt"]).rows, ["ACGT"]);
});

test("align: rows come back in input order, all one length", () => {
  const ins = A.slice(0, 20) + "GGG" + A.slice(20);
  const del = A.slice(0, 40) + A.slice(44);
  const inputs = [sub(A, 10, "A"), ins, A, del, A.slice(8)];
  const { rows, order } = S.align(inputs);
  wellFormed(rows, inputs);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4]);
  // the unmodified sequence is closest to all the others, so it goes first
  assert.equal(order[0], 2);
});

test("align: the same insertion in two rows shares its columns", () => {
  const ins = A.slice(0, 30) + "TTTT" + A.slice(30);
  const { rows } = S.align([A, ins, ins, A]);
  assert.equal(rows[0].length, A.length + 4);
  assert.equal(rows[1], ins);
  assert.equal(rows[2], ins);
  assert.equal(rows[0], rows[3]);
  assert.equal(rows[0].slice(30, 34), "----");
});

test("align: deterministic", () => {
  const inputs = [A, sub(A, 5, "C"), A.slice(3), B, sub(B, 40, "A")];
  assert.deepEqual(S.align(inputs), S.align(inputs));
});

test("consensus: majority per column, among the rows that cover it", () => {
  const { seq, depth, support } = S.consensus([
    "ACGTA-",
    "ACCTAG",
    "ACCT--",
    "--GTAG",
  ]);
  // col 2: G,C,C,G ties to a base in ACGT order → C (2 votes each, C first)
  // col 5: only the rows reaching it vote; the third row's gap there is overhang
  //        and the first row's is too, so G wins 2–0
  assert.equal(seq, "ACCTAG");
  assert.deepEqual(depth, [3, 3, 4, 4, 3, 2]);
  assert.deepEqual(support, [3, 3, 2, 4, 3, 2]);
});

test("consensus: a gap wins where most rows skip the column, loses a tie", () => {
  assert.equal(S.consensus(["AC-GT", "AC-GT", "ACAGT"]).seq, "AC-GT");
  assert.equal(S.consensus(["AC-GT", "ACAGT"]).seq, "ACAGT");
});

test("consensus: Ns don't vote", () => {
  assert.equal(S.consensus(["ANGT", "ACGT", "ANGT"]).seq, "ACGT");
  assert.equal(S.consensus(["ANGT", "ANGT"]).seq, "ANGT");
});

test("compare: substitutions, insertions, deletions and overhang", () => {
  const cons = "ACGT-ACGTA";
  const d = S.compare("--GAT-C-TA", cons);
  // 0–1 overhang, 2 G=G, 3 A≠T, 4 T under a consensus gap, 5 gap under A,
  // 6 C=C, 7 gap under G, 8–9 TA=TA
  assert.deepEqual([...d.states], [" ", " ", "=", "x", "+", "-", "=", "-", "=", "="]);
  assert.equal(d.same, 4);
  assert.equal(d.subs, 1);
  assert.equal(d.ins, 1);
  assert.equal(d.dels, 2);
  assert.equal(d.identity, 4 / 8);
  assert.deepEqual(d.span, [2, 9]);
});

test("compare: a gap opposite a consensus gap is not a difference", () => {
  const d = S.compare("AC-GT", "AC-GT");
  assert.equal(d.states, "==.==");
  assert.equal(d.identity, 1);
});

test("compare: N is no call", () => {
  const d = S.compare("ANGT", "ACGN");
  assert.equal(d.states, "=n=n");
  assert.equal(d.unknown, 2);
  assert.equal(d.identity, 1);
});

test("analyze: groups by species, largest first, skipping blank sequences", () => {
  const recs = [
    { Sample: "S1", Species: "HRV-A", Sequence: A },
    { Sample: "S2", Species: "OC43", Sequence: B },
    { Sample: "S3", Species: "HRV-A", Sequence: sub(A, 12, "T") },
    { Sample: "S4", Species: "HRV-A", Sequence: "" },
    { Sample: "S5", Species: "INFA", Sequence: "" },
    { Sample: "S6", Species: "HRV-A", Sequence: A.slice(5) },
  ];
  const g = S.analyze(recs);
  assert.deepEqual(g.map(x => x.species), ["HRV-A", "OC43"]);
  const hrv = g[0];
  assert.deepEqual(hrv.members.map(m => m.label), ["S1", "S3", "S6"]);
  assert.equal(hrv.consensus, A);
  assert.deepEqual(hrv.variable, [12]);
  assert.equal(hrv.members[1].diff.subs, 1);
  assert.equal(hrv.members[2].diff.states.slice(0, 5), "     ");
  assert.equal(hrv.members[2].diff.identity, 1);
  assert.equal(hrv.members[0].record, recs[0]);
  // a group of one is its own consensus
  assert.equal(g[1].consensus, B);
  assert.deepEqual(g[1].variable, []);
});

test("analyze: ties in size sort by name; field names can be changed", () => {
  const g = S.analyze([
    { name: "x", sp: "b", seq: A },
    { name: "y", sp: "a", seq: B },
    { name: "z", sp: "", seq: A },
  ], { fields: { label: "name", species: "sp", sequence: "seq" } });
  assert.deepEqual(g.map(x => x.species), ["(no species)", "a", "b"]);
  assert.equal(g[1].members[0].label, "y");
});

test("analyze: the differences from the consensus are the ones put in", () => {
  // five variants of one sequence, each with its own change: the consensus is
  // the original and each row reports exactly its own edit
  const inputs = [
    sub(A, 7, "T"),
    A.slice(0, 20) + A.slice(22),                    // 2 bp deletion
    A.slice(0, 40) + "C" + A.slice(40),              // 1 bp insertion
    sub(A, 50, "A"),
    A,
  ];
  const g = S.analyze(inputs.map((Sequence, k) => ({ Sample: "S" + k, Species: "X", Sequence })))[0];
  assert.equal(S.ungap(g.consensus), A);
  const d = g.members.map(m => m.diff);
  assert.deepEqual(d.map(x => [x.subs, x.dels, x.ins]),
    [[1, 0, 0], [0, 2, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]]);
});

/* ============================ against a reference ============================
   A made-up genome: random flanks, then an amplicon of a forward primer site,
   the sequence A, and a reverse primer site. The samples are A and variants
   of it, primer-trimmed, the way pathogens.csv holds them. */
function random(n, seed) {
  let x = seed, s = "";
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += "ACGT"[x >> 16 & 3]; }
  return s;
}
const FWD = "CAAGCACTTCTGTTTCCCCG";
const REV_SITE = "ACTACTTTGGGTGTCCGTGT";             // the reverse primer is its complement
const GENOME = random(400, 7) + FWD + A + REV_SITE + random(400, 11);
const AMP = 400;                                    // where the amplicon starts
const DESIGN = { label: "X rc", fwd: FWD, rev: S.revcomp(REV_SITE), probe: A.slice(20, 38) };

test("oligos: ambiguity codes, and the reverse complement", () => {
  assert.equal(S.revcomp("ACGTRYN"), "NRYACGT");
  assert.equal(S.oligo("acgu ry-x"), "ACGTRYN");
  const hit = S.findOligo(GENOME, FWD.slice(0, 4) + "Y" + FWD.slice(5))[0];  // C is a Y
  assert.deepEqual([hit.start, hit.strand, hit.mismatches], [AMP, 1, 0]);
  const rev = S.findOligo(GENOME, DESIGN.rev)[0];
  assert.deepEqual([rev.start, rev.strand], [AMP + 80, -1]);
  const off = S.findOligo(GENOME, sub(FWD, 3, "T"))[0];
  assert.deepEqual([off.mismatches, off.mis], [1, [AMP + 3]]);
});

test("oligos: a base the reference adds or lacks is one difference, not a slide", () => {
  // the probe against a genome with one extra base in the middle of its site
  const probe = A.slice(20, 38);
  const extra = random(200, 3) + A.slice(20, 29) + "T" + A.slice(29, 38) + random(200, 5);
  const hit = S.findOligo(extra, probe)[0];
  assert.deepEqual([hit.start, hit.end, hit.mismatches, hit.extra, hit.subs], [200, 219, 1, 1, 0]);
  assert.equal(hit.mis.length, 1);
  // and one missing
  const short = random(200, 3) + A.slice(20, 29) + A.slice(30, 38) + random(200, 5);
  const miss = S.findOligo(short, probe)[0];
  assert.deepEqual([miss.start, miss.end, miss.mismatches, miss.missing], [200, 217, 1, 1]);
  assert.deepEqual(miss.gaps.length, 1);
});

test("placeAssay: the primers bracket the amplicon, the probe inside it", () => {
  const at = S.placeAssay(GENOME, DESIGN);
  assert.deepEqual([at.start, at.end, at.inner], [AMP, AMP + 100, [AMP + 20, AMP + 80]]);
  assert.equal(at.probe.start, AMP + 40);
  // the same, read off the other strand
  const flipped = S.placeAssay(S.revcomp(GENOME), DESIGN);
  assert.equal(flipped.end - flipped.start, 100);
  assert.equal(S.placeAssay(GENOME, { fwd: B.slice(0, 20), rev: B.slice(30, 50) }), null);
});

test("analyze: a reference is cut to the amplicon, with its primers marked", () => {
  const recs = [
    { Sample: "S1", Species: "X", Sequence: A },
    { Sample: "S2", Species: "X", Sequence: sub(A, 30, A[30] === "A" ? "C" : "A") },
    { Sample: "S3", Species: "X", Sequence: A.slice(10) },
  ];
  const decoy = { label: "X other", fwd: B.slice(0, 20), rev: B.slice(40, 60) };
  const g = S.analyze(recs, {
    reference: sp => sp === "X" ? { accession: "NC_X", seq: GENOME, designs: [decoy, DESIGN] } : null,
  })[0];
  const ref = g.reference;
  assert.equal(ref.assay.label, "X rc");
  assert.deepEqual([ref.start, ref.end, ref.row], [AMP, AMP + 100, FWD + A + REV_SITE]);
  assert.equal(ref.position[0], AMP + 1);                       // GenBank numbering
  assert.deepEqual(ref.features.map(f => [f.kind, ...f.cols]),
    [["fwd", 0, 19], ["rev", 80, 99], ["probe", 40, 57]]);
  assert.deepEqual(g.members.map(m => [m.diff.subs, m.diff.identity]), [[0, 1], [1, 59 / 60], [0, 1]]);
  assert.deepEqual(g.variable, [50]);
  assert.equal(g.members[2].diff.span[0], 30);                  // starts 10 bp late
});

test("analyze: with no reference, or a reference the designs miss", () => {
  const recs = [{ Sample: "S1", Species: "X", Sequence: A }];
  assert.equal(S.analyze(recs, { reference: () => null })[0].consensus, A);
  const g = S.analyze(recs, { reference: () => ({ accession: "NC_X", seq: GENOME, designs: [] }) })[0];
  assert.equal(g.reference.assay, null);
  assert.equal(g.reference.row, A);                             // just where the sample sits
  assert.deepEqual(g.reference.features, []);
});
