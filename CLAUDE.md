# CLAUDE.md — Pub Tracker

## Project

Pub Tracker takes a CSV/XLSX of PI names and finds each PI's most recent paper in OpenAlex, Semantic Scholar, PubMed, and ORCID, then exports an XLSX with links. A partnership of Nathan Layman (University of Idaho), Stephen Wright (Idaho State University), and AI4RA.

## The one rule: nothing goes through our servers

Everything runs in the browser on GitHub Pages. The browser calls each upstream API directly (all four send `Access-Control-Allow-Origin: *`). **Do not add a proxy, a backend, or calls to ai4ra-mcp or any other server we run** — the Data privacy dialog promises users that none of their data reaches us. If a source can't be called from a browser, it doesn't get queried; it gets a link instead.

- **Google Scholar** has no API and blocks cross-origin requests (SerpAPI blocks them too), so it is a per-PI search link only (`sources/scholar.js`).
- Only name, institution and ORCID leave the browser. Other columns in the upload are never read.

## Two ways to run

- **The public site** (`docs/`, GitHub Pages from AI4RA/pub-tracker): a demo for one-off "most recent paper" lookups, plus the deploy guide (`docs/deploy.html`). Everything in the browser.
- **A private copy made from the template**: `tracker/track.mjs`, run weekly by `.github/workflows/track.yml`, keeps `data/papers.xlsx` (one row per PI + paper, never deleted, with "First seen") from `data/pis.xlsx`, and reports new papers via a GitHub issue (default) and optional SMTP (`tracker/notify-email.mjs`). It imports the same `docs/js` modules, so keep those runnable in Node (no DOM at import time; `docs/js/package.json` marks them as ESM). The tracking workflow is guarded with `if: github.repository != 'AI4RA/pub-tracker'`, and the Pages job skips private repos. Never commit a real PI list or `papers.xlsx` here.
- Reuse is welcome with attribution (NOTICE, LICENSE, a credit line); see the "Make it your own" sections of the README and deploy guide.

## Tech stack

- **Vanilla JS** — ES modules, no build step, no framework
- **SheetJS 0.18.5** (cdnjs) — reads CSV/XLSX, writes XLSX with hyperlinks
- Optional API keys (OpenAlex, Semantic Scholar, NCBI) and contact email in `sessionStorage`, cleared on every load; `?openalex=&s2=&ncbi=&email=` URL params are read once and stripped

## Architecture

```
docs/js/
├── keys.js        — optional keys: URL params → sessionStorage
├── http.js        — per-source rate limiter, retry/backoff on 429/5xx, abort
├── match.js       — name parsing, candidate scoring, date normalization
├── sources/       — one module per source: export id, label, lookup(pi, ctx)
│   ├── orcid.js   — also exports findOrcid(), run first to hint the others
│   ├── openalex.js, semanticscholar.js, pubmed.js
│   └── scholar.js — link only (each other source exports papers(pi, ctx, { all }))
├── lookup.js      — lookupPI (newest paper, website) and collectPapers (all papers, tracker)
├── io.js          — read upload, guess columns, write workbook
└── app.js         — UI wiring
```

## Matching rules

- When an institution is known, a source returns "none" rather than guess among namesakes elsewhere.
- Papers only: OpenAlex `type:` filter, ORCID work-type allowlist, Semantic Scholar drops Dataset/News; untyped Zenodo (10.5281) / figshare (10.6084) DOIs are skipped (`isDepositDoi` in match.js).
- Newest paper dated on or before today wins (future-dated forthcoming issues are skipped).
- Confidence: High = ≥2 sources agree (DOI or title) or ORCID came from the upload; Medium = one source matched by ORCID or name + institution; Low = name only.

## Local preview

```bash
python3 -m http.server 4173 -d docs
```

## Deployment

GitHub Pages from `docs/` on `main`. Workflow in `.github/workflows/pages.yml`.

## Related repos

- **data-crawler-carl** — same pattern (static Pages site, drop-in keys); header, modals and footer follow it
- **ai4ra-mcp** — its openalex/pubmed/orcid servers informed the query patterns here; not called at runtime
