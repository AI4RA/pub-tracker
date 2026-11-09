// PubMed (NCBI E-utilities): newest paper by full author name, narrowed by
// affiliation when an institution is known. Upstream:
// https://eutils.ncbi.nlm.nih.gov/entrez/eutils/. 3 requests a second
// without a key, 10 with one.

import { getJSON, Limiter } from '../http.js';
import { normDate, normalizeDoi } from '../match.js';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const limiter = new Limiter(370);

export const id = 'pubmed';
export const label = 'PubMed';

function common(keys) {
  const p = { tool: 'pub-tracker', retmode: 'json' };
  if (keys.email) p.email = keys.email;
  if (keys.ncbi) p.api_key = keys.ncbi;
  return p;
}

function quote(s) {
  return String(s).replace(/["[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function search(term, keys, signal) {
  const q = new URLSearchParams({ ...common(keys), db: 'pubmed', term, sort: 'pub_date', retmax: '3' });
  const body = await getJSON(`${BASE}/esearch.fcgi?${q}`, { limiter, signal });
  const r = body.esearchresult || {};
  return { count: Number(r.count || 0), ids: r.idlist || [] };
}

export async function lookup(pi, ctx) {
  const { keys, signal } = ctx;
  limiter.setInterval(keys.ncbi ? 110 : 370);
  const { first, middle, last } = pi.name;
  if (!last) return { status: 'none', note: 'No surname' };

  // [FAU] matches the full name as indexed ("Wright, Stephen J"); PubMed
  // expands "Wright, Stephen" to include middle initials automatically.
  const fau = `"${quote(last)}, ${quote([first, middle].filter(Boolean).join(' ') || first)}"[FAU]`;
  const fauLoose = `"${quote(last)}, ${quote(first)}"[FAU]`;
  const tries = [];
  if (pi.institution) tries.push({ term: `${fau} AND "${quote(pi.institution)}"[AD]`, note: 'Matched by full name + affiliation' });
  if (pi.institution && fau !== fauLoose) tries.push({ term: `${fauLoose} AND "${quote(pi.institution)}"[AD]`, note: 'Matched by full name + affiliation' });
  if (pi.institution && first) tries.push({ term: `${quote(last)} ${first[0]}[AU] AND "${quote(pi.institution)}"[AD]`, note: 'Matched by surname + initial + affiliation; verify' });
  if (!pi.institution) tries.push({ term: fau, note: 'Matched by full name only; verify' });

  let hit = null;
  for (const t of tries) {
    const r = await search(t.term, keys, signal);
    if (r.ids.length) { hit = { ...t, ...r }; break; }
  }
  if (!hit) {
    return { status: 'none', note: pi.institution ? `No papers for this name with "${pi.institution}" in the affiliation` : 'No papers for this name' };
  }

  const q = new URLSearchParams({ ...common(keys), db: 'pubmed', id: hit.ids.join(',') });
  const sum = await getJSON(`${BASE}/esummary.fcgi?${q}`, { limiter, signal });
  const today = new Date().toISOString().slice(0, 10);
  const recs = hit.ids.map(id => sum.result?.[id]).filter(Boolean)
    .map(r => ({ r, d: normDate(r.sortpubdate?.replace(/\//g, '-') || r.pubdate) }));
  const pick = recs.find(x => x.d && x.d <= today) || recs[0];
  if (!pick) return { status: 'none', note: 'Summary unavailable' };
  const { r, d } = pick;
  const doi = normalizeDoi((r.articleids || []).find(a => a.idtype === 'doi')?.value || r.elocationid);
  return {
    status: 'found',
    authorName: `${last}, ${first}`,
    title: (r.title || '').replace(/\.$/, ''),
    date: d,
    venue: r.fulljournalname || r.source || '',
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
    note: `${hit.note} (${hit.count} paper${hit.count === 1 ? '' : 's'})`,
  };
}
