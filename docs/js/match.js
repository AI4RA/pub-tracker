// Name parsing, candidate scoring, and date normalization shared by all sources.

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'dvm', 'pe', 'mph', 'msc', 'ms', 'ma', 'mba', 'dds', 'rn']);
const TITLES = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'mx']);

// Strip accents and punctuation, lowercase.
export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Accepts "Last, First Middle", "First Middle Last", or separate first/last.
// Returns { first, middle, last, full }.
export function parseName(raw, first, last) {
  if (first || last) {
    const f = String(first || '').trim();
    const l = String(last || '').trim();
    const [fi, ...mid] = f.split(/\s+/);
    return { first: fi || '', middle: mid.join(' '), last: l, full: `${f} ${l}`.trim() };
  }
  let s = String(raw || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let given, family;
  if (s.includes(',')) {
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    // "Wright, Stephen, PhD" → drop trailing suffix parts
    while (parts.length > 2 && SUFFIXES.has(norm(parts[parts.length - 1]).replace(/\s/g, ''))) parts.pop();
    family = parts[0];
    given = parts.slice(1).join(' ');
  } else {
    const toks = s.split(' ').filter(t => !SUFFIXES.has(norm(t).replace(/\s/g, '')));
    while (toks.length > 1 && TITLES.has(norm(toks[0]))) toks.shift();
    family = toks.pop() || '';
    given = toks.join(' ');
  }
  const gtoks = given.split(/\s+/).filter(t => !TITLES.has(norm(t)));
  const fi = gtoks.shift() || '';
  return { first: fi, middle: gtoks.join(' '), last: family, full: `${[fi, ...gtoks].join(' ')} ${family}`.trim() };
}

// How well does a candidate display name fit the parsed PI name? 0..3
export function nameScore(pi, candidate) {
  const c = norm(candidate);
  const last = norm(pi.last);
  const first = norm(pi.first);
  if (!last || !c.split(' ').some(t => t === last || c.includes(last))) return 0;
  const ctoks = c.split(' ');
  if (first && ctoks.includes(first)) return 3;
  if (first && ctoks.some(t => t.length === 1 && t === first[0])) return 2;
  if (first && ctoks.some(t => first.startsWith(t) || t.startsWith(first))) return 2;
  return 1;
}

// Does any of the candidate's affiliation strings match the PI's institution?
export function affiliationMatch(institution, affiliations) {
  const inst = norm(institution);
  if (!inst) return false;
  const want = inst.split(' ').filter(t => t.length > 2 && !['university', 'the', 'and', 'college', 'of'].includes(t));
  return (affiliations || []).some(a => {
    const n = norm(a);
    if (!n) return false;
    if (n.includes(inst) || inst.includes(n)) return true;
    return want.length > 0 && want.every(t => n.includes(t)) && /univ|college|institute|school/.test(n) === /univ|college|institute|school/.test(inst);
  });
}

export function normalizeOrcid(s) {
  const m = String(s || '').match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])/);
  return m ? m[1].toUpperCase() : '';
}

export function normalizeDoi(s) {
  const m = String(s || '').match(/10\.\d{4,9}\/\S+/);
  return m ? m[0].replace(/[.,;]+$/, '').toLowerCase() : '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 };

// Normalize assorted date shapes to "YYYY", "YYYY-MM", or "YYYY-MM-DD".
export function normDate(input) {
  if (!input) return '';
  if (typeof input === 'object') {
    const y = input.year, m = input.month, d = input.day;
    if (!y) return '';
    return [y, m && pad(m), m && d && pad(d)].filter(Boolean).join('-');
  }
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return [m[1], pad(m[2]), m[3] && pad(m[3])].filter(Boolean).join('-');
  m = s.match(/^(\d{4})\s+([A-Za-z]+)(?:\s+(\d{1,2}))?/); // PubMed "2023 Nov 16"
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()] || MONTHS[m[2].toLowerCase()];
    return [m[1], mo && pad(mo), mo && m[3] && pad(m[3])].filter(Boolean).join('-');
  }
  m = s.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : '';
}

function pad(n) { return String(n).padStart(2, '0'); }

// Compare normalized dates; a bare year sorts before any dated entry in that year.
export function dateKey(d) {
  return (d || '').padEnd(10, '0');
}

// Papers only: datasets, software, posters, talks and the like don't count.
// Zenodo (10.5281) and figshare (10.6084) DOIs are almost always deposits of
// data or code, so they are skipped when a source gives no type to go on.
const DEPOSIT_DOI = /^10\.(5281|6084)\//;
export function isDepositDoi(doi) {
  return DEPOSIT_DOI.test(doi || '');
}

export function titleKey(t) {
  return norm(t).replace(/\s/g, '').slice(0, 60);
}
