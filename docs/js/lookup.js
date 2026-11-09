// Runs the enabled sources for one PI. The website asks for each PI's most
// recent paper (lookupPI); the scheduled tracker asks for every paper
// (collectPapers). Both share the same matching, filtering and merging.

import * as openalex from './sources/openalex.js';
import * as s2 from './sources/semanticscholar.js';
import * as pubmed from './sources/pubmed.js';
import * as orcid from './sources/orcid.js';
import * as scholar from './sources/scholar.js';
import { dateKey } from './match.js';
import { samePaper } from './linkage.js';

export const SOURCES = [openalex, s2, pubmed, orcid, scholar];

// Dated on or before today, newest first. Forthcoming issues carry future
// placeholder dates, and an undated record can't be placed in time.
function cleanPapers(list) {
  const today = dateKey(new Date().toISOString().slice(0, 10));
  return (list || [])
    .filter(p => p.date && dateKey(p.date) <= today && p.title)
    .sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
}

// Run every enabled source once for this PI. `paused` (a Map, one per run)
// holds sources that hit a quota or refused a key: they are skipped for the
// rest of the run instead of failing, and stalling, once per PI.
async function runSources(pi, { enabled, keys, signal, paused = new Map(), all }) {
  const ctx = { keys, signal };
  const results = {};
  const fail = (id, e) => {
    if (e.name === 'AbortError') throw e;
    if (e.limit) paused.set(id, e.message);
    results[id] = { status: 'error', note: e.message };
  };
  for (const [id, msg] of paused) if (enabled.has(id)) results[id] = { status: 'skipped', note: msg };

  // ORCID first: an iD tied to the institution lets OpenAlex and Semantic
  // Scholar match exactly instead of by name.
  let hinted = pi;
  if (enabled.has('orcid') && !results.orcid) {
    try {
      ctx.orcidResult = await orcid.findOrcid(pi, ctx);
      const o = ctx.orcidResult;
      if (o.orcid && !pi.orcid && /institution/.test(o.note)) hinted = { ...pi, orcid: o.orcid };
    } catch (e) {
      fail('orcid', e);
    }
  }

  await Promise.all(SOURCES.filter(s => enabled.has(s.id) && !results[s.id]).map(async s => {
    try {
      const target = s.id === 'orcid' ? pi : hinted;
      if (!s.papers) { results[s.id] = await s.lookup(target, ctx); return; }
      const r = await s.papers(target, ctx, { all });
      if (r.status !== 'found') { results[s.id] = r; return; }
      const papers = cleanPapers(r.papers);
      results[s.id] = papers.length ? { ...r, papers } : { ...r, status: 'none', papers, note: `${r.note}; no dated papers` };
    } catch (e) {
      fail(s.id, e);
    }
  }));
  return { pi: hinted, results };
}

// ── The website: each PI's most recent paper ──
export async function lookupPI(pi, opts) {
  const { pi: hinted, results } = await runSources(pi, { ...opts, all: false });
  // Present each source's newest paper as that source's answer.
  for (const [id, r] of Object.entries(results)) {
    if (r.status === 'found' && r.papers) {
      const { papers, ...rest } = r;
      results[id] = { ...rest, ...papers[0] };
    }
  }
  return { pi: hinted, results, best: pickBest(pi, results) };
}

function pickBest(pi, results) {
  const found = SOURCES.map(s => ({ src: s, r: results[s.id] })).filter(x => x.r?.status === 'found');
  if (!found.length) return null;

  found.sort((a, b) => dateKey(b.r.date).localeCompare(dateKey(a.r.date)) || (b.r.doi ? 1 : 0) - (a.r.doi ? 1 : 0));
  const top = found[0];
  const agreeing = found.filter(x => samePaper(x.r, top.r)).map(x => x.src.label);

  // Fill gaps (venue, DOI) from agreeing sources.
  const merged = { ...top.r };
  for (const x of found) {
    if (!samePaper(x.r, top.r)) continue;
    if (!merged.venue && x.r.venue) merged.venue = x.r.venue;
    if (!merged.doi && x.r.doi) { merged.doi = x.r.doi; merged.url = `https://doi.org/${x.r.doi}`; }
  }

  return { ...merged, source: top.src.label, agreeing, confidence: confidence(pi, top.r.note, agreeing.length) };
}

function confidence(pi, note, agreeing) {
  if (agreeing >= 2 || pi.orcid) return 'High';
  if (/ORCID|institution|affiliation/.test(note || '')) return 'Medium';
  return 'Low';
}

// ── The tracker: every record from every source ──
// Returns { pi, results, records }: one record per source per paper, each
// tagged with its source, that source's own id (sid) and how the PI was
// matched there. Deciding which records are the same paper, and which are
// already known, is the tracker's job (tracker/core.mjs).
export async function collectPapers(pi, opts) {
  const { pi: hinted, results } = await runSources(pi, { ...opts, all: true });
  const records = [];
  for (const s of SOURCES) {
    const r = results[s.id];
    if (r?.status !== 'found' || !r.papers) continue;
    for (const p of r.papers) records.push({ ...p, source: s.id, sourceLabel: s.label, matchNote: r.note });
  }
  return { pi: hinted, results, records };
}
