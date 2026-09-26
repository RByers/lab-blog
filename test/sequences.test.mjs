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
