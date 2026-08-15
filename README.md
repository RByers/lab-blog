# RByers Lab Blog

## Overview

This is the source for [RByers Lab](https://lab.rbyers.ca) blog.
It is a static website built with [Astro](https://astro.build), [Google Antigravity](http://antigravity.google/), Gemini and Claude Opus.

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🔬 Tools

`public/tools/` holds standalone browser tools, listed at
[lab.rbyers.ca/tools/](https://lab.rbyers.ca/tools/). They're plain HTML, CSS
and JavaScript — no build step, no framework, no server, and no data uploaded
anywhere.

**[Data](https://lab.rbyers.ca/tools/data.html)** (`data.html`) is the one that
matters: the MolBioLab CSVs, in sortable, filterable, column-hideable tables.
Its tabs come in two blocks, split by what the lab *has* versus what its assays
*said*, and when the window is too narrow for both the block you aren't using
folds down to its name.

- **Inventory** — samples, pathogens, species, primer designs, assay panels,
  reagents and cDNA tubes, one tab each, plus per-person sampling-coverage
  stats. Sample rows are tinted by the species found in them, darker once
  sequenced, and swabs from one illness episode are banded together. The cDNA
  tab rolls `cdna.csv`'s event ledger up into one line per tube — what's left of
  it being the sum of its own rows, never a stored number — and each line opens
  to show the draws underneath.
- **Results** — every well × channel in `qPCR-results.csv`, gathered into runs
  and tinted by what the assay targets (darker = positive); every library in
  `sequencing.csv`, gathered into its run, including the ones that resolved
  nothing; plus roll-ups per assay (how often it comes up positive, its usual
  and best Cq, its contamination history) and per sample (everything ever run
  against one swab), and a per-year summary.

It watches the folder, so edits to a CSV show up on their own. The data lives
in a private repository, so the tool isn't much use without it.

The blocks link into each other. The URL hash is an address — the tab, the
search box, and what the tab is filtered to:

```
data.html#tab=inv-cdna&Sample=S90
data.html#tab=res-results&Sample=S90
```

Tab ids are qualified with the block they belong to (`inv-`, `res-`), since both
blocks have a Samples and an Assays tab. `tab` and `q` are reserved and every
other parameter is a column name, repeated for several values. That is what the
cross-links are built out of, and the address bar always holds a link you can
send to someone.

Most columns that name something defined elsewhere are one of those links. A
`Confirmed+` entry is two: the assay name goes to the tube or design it names,
and the Cq behind it to the wells it was read off. Nothing about any particular
value is written into the tool — a name is resolved against the file that
defines it (as written, then as a unique prefix, then with trailing words
dropped, so `HRV ma Cy5 probe` finds `HRV ma`), and **a link is only drawn when
it lands on a row that is really there**. What doesn't resolve stays as plain
text, and where the column is a genuine join key — an assay panel's components,
a `Confirmed+` Cq — the tool says in the notice bar what it couldn't link, which
is how a gap in the data gets noticed rather than quietly papered over.

The shared machinery — reading and watching the folder, sorting, filtering,
hiding columns, the legend, the address bar, the page chrome — is `dataview.js`
/ `dataview.css`. `inventory.js` and `results.js` are the two blocks of tabs,
each registering itself as a group; `data.js` assembles them into the app, and
`data.html` is just the title and those five files.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

