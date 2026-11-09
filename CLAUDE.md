# CLAUDE.md — Pub Tracker

## Project

Pub Tracker takes a CSV/XLSX of PI names and finds each PI's most recent paper in OpenAlex, Semantic Scholar, PubMed, and ORCID, then exports an XLSX with links. A partnership of Nathan Layman (University of Idaho), Stephen Wright (Idaho State University), and AI4RA.

## The one rule: nothing goes through our servers

Everything runs in the browser on GitHub Pages. The browser calls each upstream API directly (all four send `Access-Control-Allow-Origin: *`). **Do not add a proxy, a backend, or calls to ai4ra-mcp or any other server we run** — the Data privacy dialog promises users that none of their data reaches us. If a source can't be called from a browser, it doesn't get queried; it gets a link instead.

- **Google Scholar** has no API and blocks cross-origin requests (SerpAPI blocks them too), so it is a per-PI search link only (`sources/scholar.js`).
- Only name, institution and ORCID leave the browser. Other columns in the upload are never read.

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
│   └── scholar.js — link only
├── lookup.js      — runs sources for one PI, picks newest, scores confidence
├── io.js          — read upload, guess columns, write workbook
└── app.js         — UI wiring
```

## Matching rules

- When an institution is known, a source returns "none" rather than guess among namesakes elsewhere.
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
