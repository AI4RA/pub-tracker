// Runs every enabled source for one PI and picks the most recent paper.

import * as openalex from './sources/openalex.js';
import * as s2 from './sources/semanticscholar.js';
import * as pubmed from './sources/pubmed.js';
import * as orcid from './sources/orcid.js';
import * as scholar from './sources/scholar.js';
import { dateKey, titleKey } from './match.js';

export const SOURCES = [openalex, s2, pubmed, orcid, scholar];

// `paused` (a Map, one per run) holds sources that hit a quota or refused
// a key: they are skipped for the rest of the run instead of failing, and
// stalling, once per PI.
export async function lookupPI(pi, { enabled, keys, signal, paused = new Map() }) {
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
      results[s.id] = await s.lookup(s.id === 'orcid' ? pi : hinted, ctx);
    } catch (e) {
      fail(s.id, e);
    }
  }));

  return { pi: hinted, results, best: pickBest(pi, results) };
}

function pickBest(pi, results) {
  const found = SOURCES.map(s => ({ src: s, r: results[s.id] })).filter(x => x.r?.status === 'found');
  if (!found.length) return null;

  const same = (a, b) => (a.doi && b.doi && a.doi === b.doi) || (titleKey(a.title) && titleKey(a.title) === titleKey(b.title));
  found.sort((a, b) => dateKey(b.r.date).localeCompare(dateKey(a.r.date)) || (b.r.doi ? 1 : 0) - (a.r.doi ? 1 : 0));
  const top = found[0];
  const agreeing = found.filter(x => same(x.r, top.r)).map(x => x.src.label);

  // Fill gaps (venue, DOI) from agreeing sources.
  const merged = { ...top.r };
  for (const x of found) {
    if (!same(x.r, top.r)) continue;
    if (!merged.venue && x.r.venue) merged.venue = x.r.venue;
    if (!merged.doi && x.r.doi) { merged.doi = x.r.doi; merged.url = `https://doi.org/${x.r.doi}`; }
  }

  const strongMatch = /ORCID|institution|affiliation/.test(top.r.note || '');
  let confidence;
  if (agreeing.length >= 2 || pi.orcid) confidence = 'High';
  else if (strongMatch) confidence = 'Medium';
  else confidence = 'Low';

  return { ...merged, source: top.src.label, agreeing, confidence };
}
