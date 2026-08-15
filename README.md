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
anywhere. Both tools read the same folder of MolBioLab CSVs, which you pick
once: the chosen folder is remembered, and shared between them.

- **[Inventory](https://lab.rbyers.ca/tools/inventory.html)**
  (`inventory.html`) — samples, pathogens, species, primer designs and
  reagents, one tab each, plus per-person sampling-coverage stats. Sample rows
  are tinted by the species found in them, darker once sequenced, and swabs
  from one illness episode are banded together.
- **[qPCR results](https://lab.rbyers.ca/tools/qpcr.html)** (`qpcr.html`) —
  every well × channel in `qPCR-results.csv`, gathered into runs and tinted by
  what the assay targets (darker = positive), plus roll-ups per assay (how
  often it comes up positive, its usual and best Cq, its contamination
  history) and per sample (everything ever run against one swab), and a
  per-year summary.

Both watch the folder, so edits to a CSV show up on their own. The data lives
in a private repository, so the tools aren't much use without it.

The shared machinery — reading and watching the folder, sorting, filtering,
hiding columns, the legend, the page chrome — is `dataview.js` / `dataview.css`,
and each tool adds only its own `.js` and `.css`. A tool's `.html` is just the
title and those four files.

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

