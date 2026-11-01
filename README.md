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

The lab tools used to live in `public/tools/`. They now have their own
repository, [RByers/lab-tools](https://github.com/RByers/lab-tools), and are
served at [lt.rbyers.ca](https://lt.rbyers.ca/). `public/tools/` keeps only two
redirect pages, so old `lab.rbyers.ca/tools/` links still land in the right
place.

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

