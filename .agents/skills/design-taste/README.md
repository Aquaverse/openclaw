# design-taste

A design skill for coding agents, built from a study of 247 curated sites (One Page Love and Awwwards
Sites of the Day, October 2026). It gives an agent an art direction instead of letting it fall back on
the average landing page, holds it to a strict no-ornament house style, and makes it look at its own
render before calling the work done.

## How it works

Establish the brief and brand, choose a subject-specific direction, build a static composition, validate, optionally add purposeful motion, then critique screenshots for up to three rounds. Review-only requests stay read-only.

Functional findings and advisory style warnings are separated by scripts/lib/policy.mjs. Both lint and inspect accept --allow for style rules; functional findings cannot be suppressed. Static and text-only pages can pass. Image, animation and headline-length quotas are not acceptance criteria. SKILL.md governs imported reference examples and generated sheets.

Research in references/research.md records model judgments and rounds where baselines performed better; it is not evidence of general superiority.

## Contents

```
SKILL.md                 scope, priorities, workflow and validation policy
references/              copy, type, colour, layout, imagery, motion, critique, tells, research
scripts/draw.mjs         deal options / a direction / reprint / redraw; --alternatives, --photos, --site
scripts/assets.mjs       search open image collections (Openverse, Wikimedia Commons, Art Institute of
                         Chicago, the Met) and, with --video, real footage (Wikimedia Commons, Internet
                         Archive, NASA); --get downloads with the credit, --credits prints them
scripts/lint.mjs         static scan for banned patterns and stock phrases
scripts/inspect.mjs      render, measure, photograph
scripts/lib/             zero-dependency Chrome DevTools client, the in-page probe, the rules
library/                 directions (20), heroes, sections, type systems, palettes, photographs,
                         studied sites, motions
assets/base.css, base.js an optional neutral foundation
evals/evals.json         six briefs for testing the skill against a no-skill baseline
```

## Requirements

Node 22 or newer and an installed Chrome, Edge or Chromium for `inspect.mjs` (it drives the browser
over the DevTools protocol with Node's built-in WebSocket; nothing is installed). `draw.mjs`,
`lint.mjs` and `assets.mjs` run on Node 18+; `assets.mjs` needs network access and no API keys. Set
`CHROME_PATH` if the browser is somewhere unusual.

## Install

Copy this folder to your skills directory, for example `~/.claude/skills/design-taste/`, or keep it in
a repository under `.claude/skills/`.

## Notes

- Photographs in the library are served by Lorem Picsum from Unsplash, under the Unsplash licence.
  They are placeholders for atmosphere; replace them with the project's own pictures.
- Pictures found with `assets.mjs` keep their own licences. By default it offers only CC0, public
  domain, CC BY and CC BY-SA, and `--get` records the title, creator, licence and source of every
  download in `assets/credits.json`. The page must carry the credits (`--credits` prints them).
- `assets.mjs --video` finds short clips of the subject's world, takes a 720p-or-smaller rendition,
  refuses files over 25 MB unless `--max-mb` is passed, and saves a poster frame with each clip; how
  to use one on a page (muted loop, poster, stopped under reduced motion) is in
  `references/imagery.md` §11.
- Fonts are loaded from Google Fonts and Fontshare. Check each face's licence for your use.
- The scores in `references/research.md` are model judgements from screenshots, not Awwwards scores.
- The draw history lives in `~/.design-taste/history.json` (set `DESIGN_TASTE_HISTORY` to move it).
  Delete it to reset.
- A build takes an agent roughly 30–45 minutes and a few hundred thousand tokens with the full
  look-and-fix loop; most of that is finding or drawing pictures when a project has no photographs.

## Checks

Run `node scripts/inspect.mjs <url-or-html> [--out DIR] [--allow rule,rule] [--json]`. Responsive coverage is fixed at 1440, 768 and 390 pixels. Unsupported options and missing values exit 2 before a browser starts.

Regression tests: `node --test scripts/policy.test.mjs` (from this skill folder).
