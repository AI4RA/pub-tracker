// OpenAlex: find the author (by ORCID when known, else by name scored on
// institution), then their newest work sorted by publication date.
// Upstream: https://api.openalex.org. No key needed; a free key from
// openalex.org/settings/api gives the caller their own daily budget.

import { getJSON, Limiter } from '../http.js';
import { nameScore, affiliationMatch, normDate, normalizeDoi } from '../match.js';

const BASE = 'https://api.openalex.org';
const limiter = new Limiter(120);

export const id = 'openalex';
export const label = 'OpenAlex';

function params(keys, extra) {
  const p = new URLSearchParams(extra);
  if (keys.email) p.set('mailto', keys.email);
  if (keys.openalex) p.set('api_key', keys.openalex);
  return p;
}

// Institution name → OpenAlex institution id, once per run per name.
const instCache = new Map();
function institutionId(name, keys, signal) {
  const k = name.toLowerCase();
  if (!instCache.has(k)) {
    instCache.set(k, getJSON(`${BASE}/institutions?${params(keys, { search: name, per_page: '1', select: 'id,display_name' })}`, { limiter, signal })
      .then(b => {
        const r = (b.results || [])[0];
        return r && affiliationMatch(name, [r.display_name]) ? String(r.id).split('/').pop() : '';
      })
      .catch(e => { instCache.delete(k); throw e; }));
  }
  return instCache.get(k);
}

export async function lookup(pi, ctx) {
  const { keys, signal } = ctx;
  let author = null;
  let note = '';

  if (pi.orcid) {
    try {
      author = await getJSON(`${BASE}/authors/orcid:${pi.orcid}?${params(keys, {})}`, { limiter, signal });
      note = 'Matched by ORCID';
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  if (!author) {
    // Prefer authors who have ever been at the institution; fall back to a
    // plain name search scored on affiliation when OpenAlex can't resolve it.
    let results = [];
    const instId = pi.institution ? await institutionId(pi.institution, keys, signal) : '';
    if (instId) {
      const b = await getJSON(`${BASE}/authors?${params(keys, { search: pi.name.full, filter: `affiliations.institution.id:${instId}`, per_page: '25' })}`, { limiter, signal });
      results = (b.results || []).map(a => ({ ...a, _inInst: true }));
    }
    if (!results.length) {
      const b = await getJSON(`${BASE}/authors?${params(keys, { search: pi.name.full, per_page: '25' })}`, { limiter, signal });
      results = b.results || [];
    }
    const scored = results.map(a => {
      const affs = [
        ...(a.last_known_institutions || []).map(i => i.display_name),
        ...(a.affiliations || []).map(x => x.institution?.display_name),
      ];
      const ns = nameScore(pi.name, a.display_name);
      const am = a._inInst || affiliationMatch(pi.institution, affs);
      return { a, ns, am, score: ns * 10 + (am ? 50 : 0) + Math.log10((a.works_count || 0) + 1) };
    }).filter(x => x.ns >= 2);
    scored.sort((x, y) => y.score - x.score);
    if (!scored.length) return { status: 'none', note: 'No author with a matching name' };
    const best = scored[0];
    if (pi.institution && !best.am) {
      return { status: 'none', note: `${scored.length} name match(es), none at ${pi.institution}`, candidates: scored.length };
    }
    author = best.a;
    note = best.am ? `Matched by name + institution (${scored.length} name match${scored.length > 1 ? 'es' : ''})`
                   : `Matched by name only (${scored.length} candidate${scored.length > 1 ? 's' : ''}); verify`;
  }

  const authorId = String(author.id).split('/').pop();
  const works = await getJSON(`${BASE}/works?${params(keys, {
    filter: `author.id:${authorId}`,
    sort: 'publication_date:desc',
    per_page: '5',
    select: 'id,doi,title,publication_date,publication_year,primary_location,type',
  })}`, { limiter, signal });

  const today = new Date().toISOString().slice(0, 10);
  // Skip records dated in the future (forthcoming issues carry placeholder dates).
  const w = (works.results || []).find(x => !x.publication_date || x.publication_date <= today) || (works.results || [])[0];
  if (!w) return { status: 'none', note: `${note}; author has no works`, authorName: author.display_name, authorUrl: author.id };

  const doi = normalizeDoi(w.doi);
  return {
    status: 'found',
    authorName: author.display_name,
    authorUrl: author.id,
    title: w.title || '',
    date: normDate(w.publication_date || w.publication_year),
    venue: w.primary_location?.source?.display_name || '',
    doi,
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url || w.id),
    note,
    orcid: author.orcid ? String(author.orcid).split('/').pop() : '',
  };
}
