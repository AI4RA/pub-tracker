// ORCID public API: find the iD (given in the upload, or searched by name and
// institution), then the newest work on the person's own record.
// Upstream: https://pub.orcid.org/v3.0. No key needed.

import { getJSON, Limiter } from '../http.js';
import { nameScore, affiliationMatch, normDate, dateKey, normalizeDoi } from '../match.js';

const BASE = 'https://pub.orcid.org/v3.0';
const limiter = new Limiter(120);

export const id = 'orcid';
export const label = 'ORCID';

function term(field, value) {
  const v = String(value).replace(/["\\]/g, '').trim();
  return /\s/.test(v) ? `${field}:"${v}"` : `${field}:${v}`;
}

// Resolve the PI's ORCID iD. Exported so other sources can reuse it.
export async function findOrcid(pi, { signal }) {
  if (pi.orcid) return { orcid: pi.orcid, note: 'ORCID from upload' };
  const parts = [term('family-name', pi.name.last)];
  if (pi.name.first) parts.push(term('given-names', pi.name.first));
  const run = async extra => {
    const q = new URLSearchParams({ q: [...parts, ...extra].join(' AND '), rows: '20' });
    const body = await getJSON(`${BASE}/expanded-search/?${q}`, { limiter, signal });
    return body['expanded-result'] || [];
  };

  let hits = pi.institution ? await run([term('affiliation-org-name', pi.institution)]) : [];
  let viaInst = hits.length > 0;
  if (!hits.length) hits = await run([]);

  const scored = hits.map(h => {
    const name = `${h['given-names'] || ''} ${h['family-names'] || ''}`;
    return { h, ns: nameScore(pi.name, name), am: affiliationMatch(pi.institution, h['institution-name']) };
  }).filter(x => x.ns >= 2);
  scored.sort((a, b) => (b.am - a.am) || (b.ns - a.ns));
  if (!scored.length) return { orcid: '', note: 'No ORCID record with a matching name' };
  if (!viaInst && !scored[0].am && scored.length > 1) {
    return { orcid: '', note: `${scored.length} ORCID records share this name; none tied to the institution` };
  }
  const n = scored.length;
  return {
    orcid: scored[0].h['orcid-id'],
    note: viaInst || scored[0].am ? `Matched by name + institution (${n} record${n > 1 ? 's' : ''})` : 'Matched by name only (one record); verify',
  };
}

export async function lookup(pi, ctx) {
  const { signal } = ctx;
  const found = ctx.orcidResult || await findOrcid(pi, ctx);
  if (!found.orcid) return { status: 'none', note: found.note };

  const body = await getJSON(`${BASE}/${found.orcid}/works`, { limiter, signal });
  const today = new Date().toISOString().slice(0, 10);
  const works = (body.group || []).map(g => {
    const s = (g['work-summary'] || [])[0] || {};
    const ids = s['external-ids']?.['external-id'] || [];
    const doi = normalizeDoi(ids.find(x => x['external-id-type'] === 'doi')?.['external-id-value']);
    const pd = s['publication-date'] || {};
    const d = normDate({ year: pd.year?.value, month: pd.month?.value, day: pd.day?.value });
    return {
      title: s.title?.title?.value || '',
      venue: s['journal-title']?.value || '',
      doi, d,
      url: doi ? `https://doi.org/${doi}` : (s.url?.value || `https://orcid.org/${found.orcid}`),
    };
  }).filter(w => w.d && dateKey(w.d) <= dateKey(today));
  works.sort((a, b) => dateKey(b.d).localeCompare(dateKey(a.d)));

  const authorUrl = `https://orcid.org/${found.orcid}`;
  if (!works.length) return { status: 'none', note: `${found.note}; record lists no dated works`, authorUrl, orcid: found.orcid };
  const w = works[0];
  return {
    status: 'found',
    authorName: found.orcid,
    authorUrl,
    orcid: found.orcid,
    title: w.title, date: w.d, venue: w.venue, doi: w.doi, url: w.url,
    note: found.note,
  };
}
