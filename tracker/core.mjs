// The tracker's bookkeeping, kept free of files and network so it can be
// tested on its own (tests/core.test.mjs).
//
// Two problems, solved separately:
//
// 1. Not adding a paper we already have. Every record ever seen is in a
//    ledger that maps each of its identifiers (the source's own id, the DOI,
//    the cleaned title) to a Paper ID. A fetched record is known if any of
//    its identifiers is in the ledger, so a paper is never re-added, however
//    late a source indexes it. Deleting a row tells the tracker to ignore
//    that paper for good; giving two rows the same Paper ID merges them.
//
// 2. Telling which records from different sources are the same paper. Only
//    new records need this, and the rules in docs/js/linkage.js decide:
//    same DOI, or same title within a year, is the same paper; anything
//    close but uncertain is listed under "Possible duplicates" for a person
//    to settle once, by writing "same" or "different" in that sheet.

import { compareRecords, groupRecords, representative, isPreprint, normDoi, titleKey } from '../docs/js/linkage.js';

export const PAPER_COLS = ['Paper ID', 'PI', 'Institution', 'Title', 'Publication date', 'Journal / venue', 'DOI', 'Link', 'Other versions', 'Found in', 'Confidence', 'First seen', 'PI ORCID'];
export const LEDGER_COLS = ['PI', 'Key', 'Paper ID', 'Source', 'First seen', 'Status'];
export const DUP_COLS = ['PI', 'Paper ID A', 'Title A', 'Date A', 'DOI A', 'Paper ID B', 'Title B', 'Date B', 'DOI B', 'Why flagged', 'Decision'];
export const APART_COLS = ['PI', 'Paper ID A', 'Paper ID B', 'Decided'];

export const piKey = raw => String(raw || '').trim().toLowerCase();
const year = d => Number(String(d || '').slice(0, 4)) || null;
const splitList = s => String(s || '').split(/[;,]\s*/).map(x => x.trim()).filter(Boolean);
const pairKey = (pi, a, b) => `${piKey(pi)}|${[a, b].sort().join('|')}`;

// Identifiers a record or row is known by, as ledger keys.
export function recordKeys(rec) {
  const keys = [];
  if (rec.source && rec.sid) keys.push(`${rec.source}:${rec.sid}`);
  const doi = normDoi(rec.doi);
  if (doi) keys.push(`doi:${doi}`);
  const t = titleKey(rec.title);
  if (t) keys.push(`title:${t}`);
  return keys;
}

function rowKeys(row) {
  const keys = recordKeys({ doi: row.DOI, title: row.Title });
  for (const d of splitList(row['Other versions'])) {
    const n = normDoi(d);
    if (n) keys.push(`doi:${n}`);
  }
  return keys;
}

function confidence(row, notes, orcidFromList) {
  const n = splitList(row['Found in']).length;
  if (n >= 2 || orcidFromList) return 'High';
  if (notes.some(x => /ORCID|institution|affiliation/.test(x || ''))) return 'Medium';
  return 'Low';
}

// Merge row b into row a (same paper): keep a's id and the earliest First seen.
function foldRows(a, b) {
  const versions = new Set([...splitList(a['Other versions']), ...splitList(b['Other versions'])]);
  if (b.DOI && normDoi(b.DOI) !== normDoi(a.DOI)) versions.add(b.DOI);
  // Prefer the published version as the row's main record.
  const keepB = isPreprint({ doi: a.DOI, venue: a['Journal / venue'] }) && b.DOI && !isPreprint({ doi: b.DOI, venue: b['Journal / venue'] });
  const main = keepB ? { ...a, Title: b.Title, 'Publication date': b['Publication date'], 'Journal / venue': b['Journal / venue'], DOI: b.DOI, Link: b.Link } : { ...a };
  if (keepB && a.DOI) versions.add(a.DOI);
  versions.delete(main.DOI);
  return {
    ...main,
    'Journal / venue': main['Journal / venue'] || b['Journal / venue'] || '',
    DOI: main.DOI || b.DOI || '',
    Link: main.Link || b.Link || '',
    'Other versions': [...versions].filter(v => normDoi(v) !== normDoi(main.DOI)).join('; '),
    'Found in': [...new Set([...splitList(a['Found in']), ...splitList(b['Found in'])])].join(', '),
    'First seen': [a['First seen'], b['First seen']].filter(Boolean).sort()[0] || '',
    'PI ORCID': a['PI ORCID'] || b['PI ORCID'] || '',
  };
}

/**
 * Apply one run.
 * @param state   { papers, ledger, keptApart, decisions } as read from the workbook
 * @param fetched [{ pi: { raw, institution, orcid, orcidFromList }, records, ok }]
 * @param opts    { today, notifyAfter (YYYY-MM-DD) }
 * @returns { papers, ledger, keptApart, possible, fresh, published, log }
 */
export function applyRun(state, fetched, { today, notifyAfter = '' } = {}) {
  const log = [];
  let papers = (state.papers || []).map(r => ({ ...r }));
  let ledger = (state.ledger || []).map(r => ({ ...r }));
  const apart = new Map((state.keptApart || []).map(r => [pairKey(r.PI, r['Paper ID A'], r['Paper ID B']), r]));

  // ── Paper IDs ──
  let nextId = 1 + Math.max(0, ...[...papers, ...ledger].map(r => Number(String(r['Paper ID'] || '').replace(/\D/g, '')) || 0));
  const newId = () => `P${String(nextId++).padStart(6, '0')}`;
  for (const r of papers) if (!r['Paper ID']) r['Paper ID'] = newId();

  // PIs who had any papers or ledger entries before this run: their new
  // papers are news. Anyone else is being baselined.
  const trackedBefore = new Set([...papers, ...ledger].map(r => piKey(r.PI)));

  // ── 1. Settle the user's decisions from "Possible duplicates" ──
  const remap = new Map(); // `${pi}|${oldId}` -> newId
  for (const d of state.decisions || []) {
    const dec = String(d.Decision || '').trim().toLowerCase();
    const A = d['Paper ID A'], B = d['Paper ID B'];
    if (!A || !B) continue;
    if (/^(same|yes|duplicate|merge)/.test(dec)) {
      remap.set(`${piKey(d.PI)}|${B}`, A);
      for (const r of papers) if (piKey(r.PI) === piKey(d.PI) && r['Paper ID'] === B) r['Paper ID'] = A;
      log.push(`Merged ${B} into ${A} for ${d.PI}, as decided in Possible duplicates.`);
    } else if (/^(different|no|keep|distinct|separate)/.test(dec)) {
      apart.set(pairKey(d.PI, A, B), { PI: d.PI, 'Paper ID A': A, 'Paper ID B': B, Decided: today });
    }
  }

  // ── 2. Fold rows that now share a Paper ID (a decision, or edited by hand) ──
  const byId = new Map();
  for (const r of papers) {
    const k = `${piKey(r.PI)}|${r['Paper ID']}`;
    byId.set(k, byId.has(k) ? foldRows(byId.get(k), r) : r);
  }
  papers = [...byId.values()];
  const present = new Set(byId.keys());

  // ── 3. Bring the ledger in line with the rows ──
  // Ledger entries whose paper id vanished, but whose identifier now sits on
  // another row (the user re-labelled a row's Paper ID), follow that row.
  const keyOwner = new Map();
  for (const r of papers) for (const k of rowKeys(r)) keyOwner.set(`${piKey(r.PI)}|${k}`, r['Paper ID']);
  for (const e of ledger) {
    const pk = piKey(e.PI);
    const mapped = remap.get(`${pk}|${e['Paper ID']}`);
    if (mapped) e['Paper ID'] = mapped;
    if (e.Status !== 'ignored' && !present.has(`${pk}|${e['Paper ID']}`)) {
      const owner = keyOwner.get(`${pk}|${e.Key}`);
      if (owner) e['Paper ID'] = owner;
    }
  }
  // Rows without ledger entries (an older file, or rows typed in by hand).
  const ledgerKeys = new Set(ledger.map(e => `${piKey(e.PI)}|${e.Key}`));
  for (const r of papers) {
    for (const k of rowKeys(r)) {
      const lk = `${piKey(r.PI)}|${k}`;
      if (!ledgerKeys.has(lk)) {
        ledger.push({ PI: r.PI, Key: k, 'Paper ID': r['Paper ID'], Source: 'list', 'First seen': r['First seen'] || today, Status: 'active' });
        ledgerKeys.add(lk);
      }
    }
  }
  // Anything still pointing at a missing row was deleted by the user: ignore it from now on.
  let ignoredNow = 0;
  for (const e of ledger) {
    if (e.Status !== 'ignored' && !present.has(`${piKey(e.PI)}|${e['Paper ID']}`)) { e.Status = 'ignored'; ignoredNow++; }
  }
  if (ignoredNow) log.push(`${ignoredNow} ledger entries now ignored because their rows were deleted.`);

  // ── 4. This run's records ──
  const fresh = [];
  const published = [];
  const rowById = () => new Map(papers.map(r => [`${piKey(r.PI)}|${r['Paper ID']}`, r]));
  let rows = rowById();
  const ledgerIndex = new Map(ledger.map(e => [`${piKey(e.PI)}|${e.Key}`, e]));
  const addKey = (pi, key, id, source, status = 'active') => {
    const lk = `${piKey(pi)}|${key}`;
    if (ledgerIndex.has(lk)) return;
    const e = { PI: pi, Key: key, 'Paper ID': id, Source: source, 'First seen': today, Status: status };
    ledger.push(e);
    ledgerIndex.set(lk, e);
  };

  for (const f of fetched) {
    if (!f.ok) continue;
    const pi = f.pi;
    const pk = piKey(pi.raw);
    const notesBySource = new Map();
    for (const rec of f.records) notesBySource.set(rec.sourceLabel, rec.matchNote);
    const unknown = [];
    const touched = new Set();

    for (const rec of f.records) {
      const keys = recordKeys(rec);
      const hits = keys.map(k => ({ k, e: ledgerIndex.get(`${pk}|${k}`) })).filter(h => h.e);
      if (hits.some(h => h.e.Status === 'ignored')) {
        const id = hits.find(h => h.e.Status === 'ignored').e['Paper ID'];
        for (const k of keys) addKey(pi.raw, k, id, rec.source, 'ignored');
        continue;
      }
      // A title-only hit counts only if the years agree (a reused title years later may be a different paper).
      const usable = hits.filter(h => {
        if (!h.k.startsWith('title:')) return true;
        const row = rows.get(`${pk}|${h.e['Paper ID']}`);
        const y1 = year(row?.['Publication date']), y2 = year(rec.date);
        return !(y1 && y2 && Math.abs(y1 - y2) > 1);
      });
      if (!usable.length) { unknown.push(rec); continue; }

      const id = usable[0].e['Paper ID'];
      const row = rows.get(`${pk}|${id}`);
      for (const k of keys) addKey(pi.raw, k, id, rec.source);
      if (!row) continue;
      touched.add(row);
      // What the sources say now.
      const found = new Set(splitList(row['Found in']));
      found.add(rec.sourceLabel);
      row['Found in'] = [...found].join(', ');
      if (!row['Journal / venue'] && rec.venue) row['Journal / venue'] = rec.venue;
      if (!row['PI ORCID'] && pi.orcid) row['PI ORCID'] = pi.orcid;
      const rdoi = normDoi(rec.doi);
      if (rdoi && !normDoi(row.DOI)) { row.DOI = rdoi; row.Link = `https://doi.org/${rdoi}`; }
      else if (rdoi && rdoi !== normDoi(row.DOI)) {
        const rowIsPreprint = isPreprint({ doi: row.DOI, venue: row['Journal / venue'] });
        if (rowIsPreprint && !isPreprint(rec)) {
          // The preprint we were tracking has been published: the journal version becomes the main record.
          const versions = new Set(splitList(row['Other versions']));
          versions.add(row.DOI);
          Object.assign(row, { 'Other versions': [...versions].join('; '), DOI: rdoi, Link: `https://doi.org/${rdoi}`, 'Journal / venue': rec.venue || row['Journal / venue'], 'Publication date': rec.date || row['Publication date'] });
          if (trackedBefore.has(pk)) published.push({ ...row });
        } else if (!splitList(row['Other versions']).map(normDoi).includes(rdoi)) {
          row['Other versions'] = [...splitList(row['Other versions']), rdoi].join('; ');
        }
      }
    }

    // New records: decide which of them are the same paper, then add one row each.
    for (const group of groupRecords(unknown)) {
      const rep = representative(group);
      const id = newId();
      const doi = normDoi(rep.doi);
      const others = [...new Set(group.map(r => normDoi(r.doi)).filter(d => d && d !== doi))];
      const row = {
        'Paper ID': id,
        PI: pi.raw,
        Institution: pi.institution || '',
        Title: rep.title,
        'Publication date': rep.date || '',
        'Journal / venue': rep.venue || group.find(r => r.venue)?.venue || '',
        DOI: doi,
        Link: rep.url || (doi ? `https://doi.org/${doi}` : ''),
        'Other versions': others.join('; '),
        'Found in': [...new Set(group.map(r => r.sourceLabel))].join(', '),
        Confidence: '',
        'First seen': today,
        'PI ORCID': pi.orcid || '',
      };
      papers.push(row);
      touched.add(row);
      for (const r of group) for (const k of recordKeys(r)) addKey(pi.raw, k, id, r.source);
      if (trackedBefore.has(pk) && (!notifyAfter || String(row['Publication date']) >= notifyAfter)) fresh.push(row);
    }
    for (const row of touched) {
      const notes = splitList(row['Found in']).map(l => notesBySource.get(l));
      row.Confidence = confidence(row, notes, pi.orcidFromList);
    }
    rows = rowById();
  }

  // ── 5. Possible duplicates, for a person to settle ──
  const possible = [];
  const byPI = new Map();
  for (const r of papers) {
    const k = piKey(r.PI);
    if (!byPI.has(k)) byPI.set(k, []);
    byPI.get(k).push(r);
  }
  for (const list of byPI.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (apart.has(pairKey(a.PI, a['Paper ID'], b['Paper ID']))) continue;
        const c = compareRecords({ title: a.Title, date: a['Publication date'], doi: a.DOI }, { title: b.Title, date: b['Publication date'], doi: b.DOI });
        if (c.verdict === 'different') continue;
        possible.push({
          PI: a.PI,
          'Paper ID A': a['Paper ID'], 'Title A': a.Title, 'Date A': a['Publication date'], 'DOI A': a.DOI,
          'Paper ID B': b['Paper ID'], 'Title B': b.Title, 'Date B': b['Publication date'], 'DOI B': b.DOI,
          'Why flagged': c.verdict === 'same' ? `likely the same paper: ${c.why}` : c.why,
          Decision: '',
        });
      }
    }
  }

  return { papers, ledger, keptApart: [...apart.values()], possible, fresh, published, log };
}
