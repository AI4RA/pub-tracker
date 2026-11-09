#!/usr/bin/env node
// Pub Tracker, scheduled edition.
//
// Reads a list of PIs (data/pis.xlsx or .csv), finds every paper each one has
// in OpenAlex, Semantic Scholar, PubMed and ORCID, and keeps a running
// workbook (data/papers.xlsx) with one row per PI + paper. Rows are never
// deleted; each row remembers the date it was first seen. Papers that are new
// since the last run, for PIs who were already being tracked, are written to
// data/new-papers.md for the notification step.
//
// It uses the website's own source modules (docs/js), so matching works the
// same way in both. Configuration is by environment variable; see README.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
globalThis.XLSX = require('xlsx');
const XLSX = globalThis.XLSX;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collectPapers, SOURCES } = await import(path.join(ROOT, 'docs/js/lookup.js'));
const { parseName, normalizeOrcid, titleKey, normalizeDoi, dateKey } = await import(path.join(ROOT, 'docs/js/match.js'));
const { guessColumns } = await import(path.join(ROOT, 'docs/js/io.js'));
const { events } = await import(path.join(ROOT, 'docs/js/http.js'));

const env = (k, d = '') => (process.env[k] || d).trim();
const PIS_FILE = path.resolve(ROOT, env('PIS_FILE', firstExisting(['data/pis.xlsx', 'data/pis.csv']) || 'data/pis.xlsx'));
const PAPERS_FILE = path.resolve(ROOT, env('PAPERS_FILE', 'data/papers.xlsx'));
const NEW_FILE = path.resolve(ROOT, env('NEW_FILE', 'data/new-papers.md'));
const DEFAULT_INSTITUTION = env('DEFAULT_INSTITUTION');
const NOTIFY_MAX_AGE_DAYS = Number(env('NOTIFY_MAX_AGE_DAYS', '365'));
const ENABLED = new Set(env('SOURCES', 'openalex,s2,pubmed,orcid').split(',').map(s => s.trim()).filter(Boolean));
const KEYS = { openalex: env('OPENALEX_API_KEY'), s2: env('S2_API_KEY'), ncbi: env('NCBI_API_KEY'), email: env('CONTACT_EMAIL') };
const CONCURRENCY = 3;
const TODAY = new Date().toISOString().slice(0, 10);

function firstExisting(list) {
  return list.find(f => fs.existsSync(path.resolve(ROOT, f)));
}

function log(...a) { console.log(...a); }

// ── Read the PI list ──
if (!fs.existsSync(PIS_FILE)) {
  log(`No PI list at ${path.relative(ROOT, PIS_FILE)}. Add data/pis.xlsx (or data/pis.csv) to start tracking.`);
  setOutput('new_count', '0');
  process.exit(0);
}
const wbIn = XLSX.read(fs.readFileSync(PIS_FILE), { type: 'buffer', raw: false, codepage: 65001 });
const rowsIn = XLSX.utils.sheet_to_json(wbIn.Sheets[wbIn.SheetNames[0]], { defval: '', raw: false })
  .filter(r => Object.values(r).some(v => String(v).trim()));
const cols = guessColumns(rowsIn.length ? Object.keys(rowsIn[0]) : []);
const pis = rowsIn.map(r => {
  const split = !cols.name && cols.first && cols.last;
  const raw = split ? `${r[cols.first]} ${r[cols.last]}`.trim() : String(r[cols.name] || '').trim();
  return {
    raw,
    name: split ? parseName('', r[cols.first], r[cols.last]) : parseName(raw),
    institution: (cols.institution && String(r[cols.institution] || '').trim()) || DEFAULT_INSTITUTION,
    orcid: cols.orcid ? normalizeOrcid(r[cols.orcid]) : '',
  };
}).filter(p => p.name && p.name.last);
log(`${pis.length} PIs from ${path.relative(ROOT, PIS_FILE)} (columns: ${JSON.stringify(cols)}); sources: ${[...ENABLED].join(', ')}`);
if (!KEYS.openalex) log('Note: no OPENALEX_API_KEY, so OpenAlex runs on the small shared keyless budget.');

// ── Read what we already know ──
const COLS = ['PI', 'Institution', 'Title', 'Publication date', 'Journal / venue', 'DOI', 'Link', 'Found in', 'Confidence', 'First seen', 'PI ORCID'];
const PI_COLS = ['PI', 'Institution', 'ORCID', 'Papers tracked', 'Newest paper', 'First tracked', 'Last checked', 'Last result'];
let known = [];
let knownPIs = [];
if (fs.existsSync(PAPERS_FILE)) {
  const wb = XLSX.read(fs.readFileSync(PAPERS_FILE), { type: 'buffer' });
  if (wb.Sheets.Papers) known = XLSX.utils.sheet_to_json(wb.Sheets.Papers, { defval: '', raw: false });
  if (wb.Sheets.PIs) knownPIs = XLSX.utils.sheet_to_json(wb.Sheets.PIs, { defval: '', raw: false });
  log(`${known.length} papers already tracked for ${knownPIs.length} PIs.`);
} else {
  log('No papers workbook yet: this run is the baseline, so nothing is reported as new.');
}

const piKey = raw => String(raw).trim().toLowerCase();
const paperKey = p => normalizeDoi(p.DOI || p.doi) || titleKey(p.Title || p.title);
const byPI = new Map();
for (const row of known) {
  const k = piKey(row.PI);
  if (!byPI.has(k)) byPI.set(k, new Map());
  byPI.get(k).set(paperKey(row), row);
}
const piRows = new Map(knownPIs.map(r => [piKey(r.PI), r]));

// ── Look everyone up ──
const paused = new Map();
events.addEventListener('wait', e => log(`   waiting ${Math.round(e.detail.ms / 1000)} s for ${e.detail.host} (${e.detail.why})`));
const fresh = [];
let next = 0;
let done = 0;
async function worker() {
  while (next < pis.length) {
    const pi = pis[next++];
    const k = piKey(pi.raw);
    const wasTracked = piRows.has(k);
    let res;
    try {
      res = await collectPapers(pi, { enabled: ENABLED, keys: KEYS, signal: undefined, paused });
    } catch (e) {
      res = { pi, results: {}, papers: [], error: e.message };
    }
    done++;
    const statuses = Object.entries(res.results).map(([id, r]) => `${id}:${r.status}`).join(' ');
    const anyAnswer = Object.values(res.results).some(r => r.status === 'found' || r.status === 'none');

    const mine = byPI.get(k) || new Map();
    byPI.set(k, mine);
    let added = 0;
    for (const p of res.papers) {
      const key = paperKey(p);
      if (!key) continue;
      const row = {
        PI: pi.raw,
        Institution: pi.institution || '',
        Title: p.title,
        'Publication date': p.date,
        'Journal / venue': p.venue || '',
        DOI: p.doi || '',
        Link: p.url || '',
        'Found in': p.sources.join(', '),
        Confidence: p.confidence,
        'First seen': TODAY,
        'PI ORCID': res.pi.orcid || '',
      };
      const old = mine.get(key);
      if (old) {
        // Refresh what the sources say now; keep when we first saw it.
        mine.set(key, { ...row, 'First seen': old['First seen'] || TODAY });
      } else {
        mine.set(key, row);
        added++;
        if (wasTracked) fresh.push(row);
      }
    }
    const all = [...mine.values()];
    const newest = all.map(r => r['Publication date']).sort((a, b) => dateKey(b).localeCompare(dateKey(a)))[0] || '';
    const prev = piRows.get(k);
    piRows.set(k, {
      PI: pi.raw,
      Institution: pi.institution || '',
      ORCID: res.pi.orcid || prev?.ORCID || '',
      'Papers tracked': all.length,
      'Newest paper': newest,
      'First tracked': prev?.['First tracked'] || TODAY,
      'Last checked': TODAY,
      'Last result': res.error ? `error: ${res.error}` : anyAnswer ? `${res.papers.length} papers found; ${statuses}` : `no source answered; ${statuses}`,
    });
    log(`[${done}/${pis.length}] ${pi.raw}: ${res.papers.length} papers, ${added} new${wasTracked ? '' : ' (baseline)'}  ${statuses}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const [id, msg] of paused) log(`Source ${id} was switched off partway: ${msg}`);

// ── Write the workbook ──
const link = (text, url) => (url ? { v: text || url, t: 's', l: { Target: url } } : { v: text || '', t: 's' });
const papersRows = [...byPI.values()].flatMap(m => [...m.values()])
  .sort((a, b) => String(a.PI).localeCompare(String(b.PI)) || dateKey(b['Publication date']).localeCompare(dateKey(a['Publication date'])));
const aoa = [COLS, ...papersRows.map(r => COLS.map(c =>
  c === 'Title' ? link(r.Title, r.Link) : c === 'Link' ? link(r.Link, r.Link) : c === 'PI ORCID' && r[c] ? link(r[c], `https://orcid.org/${r[c]}`) : r[c] ?? ''))];
const ws = XLSX.utils.aoa_to_sheet(aoa);
ws['!cols'] = [24, 26, 60, 14, 30, 28, 36, 30, 11, 12, 20].map(w => ({ wch: w }));
ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: COLS.length - 1 } }) };

const piAoa = [PI_COLS, ...[...piRows.values()].sort((a, b) => String(a.PI).localeCompare(String(b.PI))).map(r => PI_COLS.map(c => r[c] ?? ''))];
const ws2 = XLSX.utils.aoa_to_sheet(piAoa);
ws2['!cols'] = [24, 26, 20, 14, 14, 13, 13, 70].map(w => ({ wch: w }));

const about = XLSX.utils.aoa_to_sheet([
  ['Pub Tracker: running list of papers'],
  ['Last run', new Date().toISOString()],
  ['PIs', pis.length],
  ['Papers', papersRows.length],
  ['Sources', [...ENABLED].map(id => SOURCES.find(s => s.id === id)?.label || id).join(', ')],
  [],
  ['One row per PI + paper. Rows are never deleted, so a paper stays even if a source later drops it.'],
  ['"First seen" is the run that first found the paper. Papers dated in the future (forthcoming issues) wait until their date arrives.'],
  ['Only papers count: articles, preprints, conference papers, reviews, books, chapters, reports and theses.'],
  ['Confidence: High = two or more sources have it, or the ORCID iD came from the PI list; Medium = one source matched by ORCID or name + institution; Low = name only, check it.'],
  ['https://github.com/AI4RA/pub-tracker'],
]);
about['!cols'] = [{ wch: 22 }, { wch: 100 }];

const wbOut = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbOut, ws, 'Papers');
XLSX.utils.book_append_sheet(wbOut, ws2, 'PIs');
XLSX.utils.book_append_sheet(wbOut, about, 'About');
fs.mkdirSync(path.dirname(PAPERS_FILE), { recursive: true });
XLSX.writeFile(wbOut, PAPERS_FILE);
log(`Wrote ${papersRows.length} papers for ${piRows.size} PIs to ${path.relative(ROOT, PAPERS_FILE)}.`);

// ── New papers, for the notification ──
const cutoff = new Date(Date.now() - NOTIFY_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
const notify = fresh.filter(r => dateKey(r['Publication date']) >= dateKey(cutoff))
  .sort((a, b) => String(a.PI).localeCompare(String(b.PI)) || dateKey(b['Publication date']).localeCompare(dateKey(a['Publication date'])));
const older = fresh.length - notify.length;
if (notify.length) {
  const lines = [`Pub Tracker found **${notify.length} new paper${notify.length === 1 ? '' : 's'}** on ${TODAY}.`, ''];
  let current = '';
  for (const r of notify) {
    if (r.PI !== current) { current = r.PI; lines.push('', `### ${r.PI}${r.Institution ? ` (${r.Institution})` : ''}`, ''); }
    const title = r.Link ? `[${r.Title.replace(/[[\]]/g, '')}](${r.Link})` : r.Title;
    lines.push(`- ${title}. ${[r['Journal / venue'], r['Publication date']].filter(Boolean).join(', ')}. Found in ${r['Found in']}; confidence ${r.Confidence}.`);
  }
  lines.push('');
  if (older) lines.push(`${older} older paper${older === 1 ? ' was' : 's were'} also newly indexed and added to the list without notice (dated before ${cutoff}).`);
  lines.push('', 'The full list is in `data/papers.xlsx`.');
  fs.writeFileSync(NEW_FILE, lines.join('\n'));
  log(`${notify.length} new papers to report (${path.relative(ROOT, NEW_FILE)}).`);
} else {
  if (fs.existsSync(NEW_FILE)) fs.rmSync(NEW_FILE);
  log(`No new papers to report${older ? ` (${older} older ones were newly indexed and added quietly)` : ''}.`);
}
setOutput('new_count', String(notify.length));
setOutput('new_file', path.relative(ROOT, NEW_FILE));
summary(`Pub Tracker: ${pis.length} PIs, ${papersRows.length} papers tracked, ${notify.length} new.${paused.size ? ` Switched off partway: ${[...paused.keys()].join(', ')}.` : ''}`);

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
