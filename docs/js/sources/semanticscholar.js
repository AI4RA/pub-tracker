// Semantic Scholar: author search scored on name, affiliation and paper count,
// then the author's papers sorted locally by publication date (the API does
// not sort an author's papers). Upstream: https://api.semanticscholar.org.
// No key needed; the public pool is throttled hard, so calls are spaced out.

import { getJSON, Limiter } from '../http.js';
import { nameScore, affiliationMatch, normDate, normalizeDoi, isDepositDoi } from '../match.js';

const BASE = 'https://api.semanticscholar.org/graph/v1';
const limiter = new Limiter(1100);

export const id = 's2';
export const label = 'Semantic Scholar';

// Not a paper: typed as a dataset or news item, or an untyped Zenodo/figshare deposit.
function isPaper(p) {
  const types = p.publicationTypes || [];
  if (types.some(t => t === 'Dataset' || t === 'News')) return false;
  if (!types.length && isDepositDoi(normalizeDoi(p.externalIds?.DOI))) return false;
  return true;
}

// Every paper by the matched author, newest first.
export async function papers(pi, ctx, { all = false } = {}) {
  const { keys, signal } = ctx;
  const headers = keys.s2 ? { 'x-api-key': keys.s2 } : {};
  limiter.setInterval(keys.s2 ? 1050 : 1100);

  const q = new URLSearchParams({ query: pi.name.full, fields: 'name,affiliations,paperCount,externalIds,url', limit: '20' });
  const body = await getJSON(`${BASE}/author/search?${q}`, { limiter, signal, headers });

  const scored = (body.data || []).map(a => {
    const ns = nameScore(pi.name, a.name);
    const am = affiliationMatch(pi.institution, a.affiliations);
    const orcidMatch = pi.orcid && a.externalIds?.ORCID === pi.orcid;
    return { a, ns, am, score: (orcidMatch ? 1000 : 0) + ns * 10 + (am ? 50 : 0) + Math.log10((a.paperCount || 0) + 1) };
  }).filter(x => x.ns >= 2);
  scored.sort((x, y) => y.score - x.score);
  if (!scored.length) return { status: 'none', note: 'No author with a matching name' };

  const best = scored[0];
  if (pi.institution && best.score < 1000 && !best.am && scored.length > 1) {
    return { status: 'none', note: `${scored.length} authors share this name and none lists ${pi.institution}; not guessing`, candidates: scored.length };
  }
  // Semantic Scholar often has no affiliation on file, so a missing match is
  // a weaker signal here than in OpenAlex: keep the pick but flag it.
  let note;
  if (best.score >= 1000) note = 'Matched by ORCID';
  else if (best.am) note = `Matched by name + affiliation (${scored.length} name match${scored.length > 1 ? 'es' : ''})`;
  else note = `Matched by name only (${scored.length} candidate${scored.length > 1 ? 's' : ''}); verify`;

  // The API does not sort an author's papers, so fetch them all and sort here.
  const pq = new URLSearchParams({ fields: 'title,publicationDate,year,venue,externalIds,url,publicationTypes', limit: all ? '1000' : '500' });
  const body2 = await getJSON(`${BASE}/author/${best.a.authorId}/papers?${pq}`, { limiter, signal, headers });
  const list = (body2.data || []).filter(isPaper).map(p => {
    const doi = normalizeDoi(p.externalIds?.DOI);
    return { sid: p.paperId || '', title: p.title || '', date: normDate(p.publicationDate || p.year), venue: p.venue || '', doi, url: doi ? `https://doi.org/${doi}` : p.url };
  });
  return { status: 'found', authorName: best.a.name, authorUrl: best.a.url, note, papers: list };
}
