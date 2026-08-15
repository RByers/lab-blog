/* data.js — the tool itself: the two blocks of tabs, and the app around them.
 *
 * inventory.js and results.js each registered a group as they loaded (they are
 * the <script>s above this one in data.html); everything they have in common —
 * the folder, the GitHub source, the table, the address bar — is dataview.js.
 * What is left, and all that's here, is what belongs to neither block alone:
 * what the tool is called, where its preferences live, and what the landing
 * card asks for.
 */
"use strict";

new Dataview.App({
  title: "Data",
  // v1 of the merged tool: the two tools' own remembered state (which tab,
  // which filters) was keyed per tool and per tab name, and neither survives
  // the tabs being renamed, so this deliberately starts clean rather than
  // trying to migrate molbiolab.inventory.v5 / molbiolab.results.v1.
  prefsKey: "molbiolab.data.v1",
  landing: "Pick the folder holding the MolBioLab CSVs — <code>samples.csv</code>, "
    + "<code>pathogens.csv</code> and <code>qPCR-results.csv</code> at least, plus "
    + "<code>species.csv</code> / <code>primers.csv</code> / <code>assays.csv</code> / "
    + "<code>reagents.csv</code> / <code>cdna.csv</code> / <code>sequencing.csv</code> for "
    + "the rest of the tabs. The repo root or its <code>data/</code> folder both work. "
    + "Nothing leaves this machine; the page only reads the files.",
  groups: Dataview.groups,
}).start();
