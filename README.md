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
[lab.rbyers.ca/tools/](https://lab.rbyers.ca/tools/). They're plain
single-file HTML — no build step, no server, no data uploaded anywhere.

- **[Inventory](https://lab.rbyers.ca/tools/inventory.html)**
  (`public/tools/inventory.html`) — reads the MolBioLab CSVs (`samples.csv`,
  `pathogens.csv`, `species.csv`, `primers.csv`, `reagents.csv`) from a local
  folder you pick and shows samples, pathogens, primer designs and reagents in
  a sortable, filterable table, plus per-person sampling coverage stats. It
  watches the folder, so edits to a CSV show up on their own. The data lives in
  a private repository, so the tool isn't much use without it.

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

