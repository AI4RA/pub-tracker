// Deciding whether two publication records are the same paper.
//
// The same paper reaches us several times: once per source, as a preprint
// and as the published article (different DOIs), and with titles that differ
// in case, punctuation or HTML markup. These rules are deliberately simple
// and predictable; anything uncertain is left for a person to decide:
//
//   same       identical DOI; or identical cleaned title (4+ words) with
//              publication years at most 1 apart
//   maybe      identical title further apart in time, or near-identical
//              titles (Jaro-Winkler >= 0.95): listed for review, not merged
//   different  everything else, and always: a correction, erratum or
//              retraction vs the article it corrects; titles that differ in
//              a part or volume number ("Part I" / "Part II")

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function normTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, ' ')                                   // <i>, <sub>, MathML
    .replace(/&(#\d+|\w+);/g, (_m, e) => e[0] === '#' ? String.fromCharCode(+e.slice(1)) : (ENTITIES[e] ?? ' '))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normDoi(d) {
  const m = String(d || '').toLowerCase().match(/10\.\d{4,9}\/\S+/);
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}

// Jaro-Winkler similarity, 0..1.
export function jaroWinkler(a, b) {
  if (a === b) return a.length ? 1 : 0;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Uint8Array(la), mb = new Uint8Array(lb);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a.charCodeAt(i) === b.charCodeAt(j)) { ma[i] = mb[j] = 1; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) t++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
  let p = 0;
  while (p < 4 && p < la && p < lb && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

const CORRECTION = /^(author )?(correction|corrigendum|erratum|retraction|retracted|expression of concern|publisher correction|addendum)\b/;
const ROMAN = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']);
const NUMBERED = /^(part|vol|volume|paper|phase|study|chapter|section|book|no|number)$/;

// Numbers that tell otherwise identical titles apart: any digits, and roman
// numerals after "part", "volume" and the like.
function distinguishingNumbers(nt) {
  const toks = nt.split(' ');
  return toks.filter((tk, i) => /^\d+$/.test(tk) || (ROMAN.has(tk) && i > 0 && NUMBERED.test(toks[i - 1]))).sort().join(',');
}

// A title long enough to identify a paper on its own ("Editorial" isn't).
export function titleKey(t) {
  const nt = normTitle(t);
  return nt.split(' ').length >= 4 ? nt : '';
}

// ── Preprints ──

const PREPRINT_DOI = /^10\.(48550|1101|21203|20944|31234|31219|31235|31222|2139|22541|26434|36227|32942|33774)\//;
const PREPRINT_VENUE = /\b(arxiv|biorxiv|medrxiv|chemrxiv|research square|preprints|ssrn|psyarxiv|socarxiv|osf preprints|authorea|eartharxiv|techrxiv|peerj preprints)\b/i;

export function isPreprint(rec) {
  return PREPRINT_DOI.test(normDoi(rec.doi)) || PREPRINT_VENUE.test(rec.venue || '');
}

// ── Comparing two records ──

function year(rec) {
  return Number(String(rec.date || '').slice(0, 4)) || null;
}

// Returns { verdict: 'same' | 'maybe' | 'different', why }.
export function compareRecords(a, b) {
  const da = normDoi(a.doi), db = normDoi(b.doi);
  if (da && da === db) return { verdict: 'same', why: 'same DOI' };
  const ta = normTitle(a.title), tb = normTitle(b.title);
  if (!ta || !tb) return { verdict: 'different', why: 'no title' };
  if (CORRECTION.test(ta) !== CORRECTION.test(tb)) return { verdict: 'different', why: 'correction vs article' };
  if (distinguishingNumbers(ta) !== distinguishingNumbers(tb)) return { verdict: 'different', why: 'different part or number' };
  const ya = year(a), yb = year(b);
  const gap = ya && yb ? Math.abs(ya - yb) : 0;
  const long = ta.split(' ').length >= 4;
  if (ta === tb && long) {
    if (gap <= 1) return { verdict: 'same', why: da && db ? 'same title, different DOIs (likely preprint and published version)' : 'same title' };
    return { verdict: 'maybe', why: `same title, ${gap} years apart` };
  }
  if (!long) return { verdict: 'different', why: 'short title' };
  const sim = jaroWinkler(ta, tb);
  if (sim >= 0.95 && gap <= 2) return { verdict: 'maybe', why: `very similar titles (${sim.toFixed(2)})` };
  return { verdict: 'different', why: 'different titles' };
}

// The website's "do these sources report the same paper?"
export function samePaper(a, b) {
  return compareRecords(a, b).verdict === 'same';
}

// Group records into papers: records joined by a 'same' verdict, directly or
// through another record, form one group.
export function groupRecords(recs) {
  const parent = recs.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      if (compareRecords(recs[i], recs[j]).verdict === 'same') {
        const a = find(i), b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map();
  recs.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

// The record that should represent a paper: the published version over a
// preprint, then one with a DOI, then the most precise date.
export function representative(recs) {
  return recs.slice().sort((a, b) =>
    (isPreprint(a) - isPreprint(b)) ||
    ((normDoi(b.doi) ? 1 : 0) - (normDoi(a.doi) ? 1 : 0)) ||
    ((b.date || '').length - (a.date || '').length) ||
    String(b.date || '').localeCompare(String(a.date || '')))[0];
}
