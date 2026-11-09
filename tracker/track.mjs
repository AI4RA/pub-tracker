#!/usr/bin/env node
// Pub Tracker, scheduled edition: tracks an institution's publications.
//
// Reads the PI list (data/pis.xlsx or .csv), fetches every paper each PI has
// in OpenAlex, Semantic Scholar, PubMed and ORCID, and keeps:
//
//   data/tracker.db   SQLite, the system of record: papers (each with a
//                     stable Paper ID of our own), a ledger of every
//                     identifier ever seen for each paper, decisions, PI
//                     status and a log of runs
//   data/papers.xlsx  rebuilt from the database each run, for people to read
//                     and review. Edits made in it (deleting a row, writing
//                     "same"/"different" under Possible duplicates, giving two
//                     rows the same Paper ID) are applied on the next run.
//   data/new-papers.md  new and newly published papers, for the notice
//
// The bookkeeping lives in core.mjs; matching rules in docs/js/linkage.js.
// It uses the website's own source modules, so both match people alike.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyRun, piKey, PAPER_COLS, DUP_COLS } from './core.mjs';
import { openStore } from './store.mjs';

const require = createRequire(import.meta.url);
globalThis.XLSX = require('xlsx');
const XLSX = globalThis.XLSX;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collectPapers, SOURCES } = await import(path.join(ROOT, 'docs/js/lookup.js'));
const { parseName, normalizeOrcid, dateKey } = await import(path.join(ROOT, 'docs/js/match.js'));
const { guessColumns } = await import(path.join(ROOT, 'docs/js/io.js'));
const { events } = await import(path.join(ROOT, 'docs/js/http.js'));

const env = (k, d = '') => (process.env[k] || d).trim();
const rel = f => path.relative(ROOT, f);
const PIS_FILE = path.resolve(ROOT, env('PIS_FILE', ['data/pis.xlsx', 'data/pis.csv'].find(f => fs.existsSync(path.resolve(ROOT, f))) || 'data/pis.xlsx'));
const DB_FILE = path.resolve(ROOT, env('DB_FILE', 'data/tracker.db'));
const PAPERS_FILE = path.resolve(ROOT, env('PAPERS_FILE', 'data/papers.xlsx'));
const NEW_FILE = path.resolve(ROOT, env('NEW_FILE', 'data/new-papers.md'));
const DEFAULT_INSTITUTION = env('DEFAULT_INSTITUTION');
const NOTIFY_MAX_AGE_DAYS = Number(env('NOTIFY_MAX_AGE_DAYS', '365'));
const ENABLED = new Set(env('SOURCES', 'openalex,s2,pubmed,orcid').split(',').map(s => s.trim()).filter(Boolean));
const KEYS = { openalex: env('OPENALEX_API_KEY'), s2: env('S2_API_KEY'), ncbi: env('NCBI_API_KEY'), email: env('CONTACT_EMAIL') };
const CONCURRENCY = 3;
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const RUN_ID = NOW.toISOString().replace(/\.\d+Z$/, 'Z');
const log = (...a) => console.log(...a);

// ── The PI list ──
if (!fs.existsSync(PIS_FILE)) {
  log(`No PI list at ${rel(PIS_FILE)}. Add data/pis.xlsx (or data/pis.csv) to start tracking.`);
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
  const orcid = cols.orcid ? normalizeOrcid(r[cols.orcid]) : '';
  return {
    raw,
    name: split ? parseName('', r[cols.first], r[cols.last]) : parseName(raw),
    institution: (cols.institution && String(r[cols.institution] || '').trim()) || DEFAULT_INSTITUTION,
    orcid,
    orcidFromList: Boolean(orcid),
  };
}).filter(p => p.name && p.name.last);
log(`${pis.length} PIs from ${rel(PIS_FILE)}; sources: ${[...ENABLED].join(', ')}`);
if (!KEYS.openalex) log('Note: no OPENALEX_API_KEY, so OpenAlex runs on the small shared keyless budget.');

// ── What we know, and what people changed in the workbook ──
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const store = openStore(DB_FILE);
const db = store.load();
let papers = db.papers;
let decisions = [];
const notes = [];
if (fs.existsSync(PAPERS_FILE)) {
  const wb = XLSX.read(fs.readFileSync(PAPERS_FILE), { type: 'buffer', raw: false });
  const sheet = name => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false }) : null);
  const exportId = (XLSX.utils.sheet_to_json(wb.Sheets.About || {}, { header: 1, defval: '' }).find(r => r[0] === 'Export ID') || [])[1] || '';
  const sheetPapers = sheet('Papers');
  // Decisions on possible duplicates refer to Paper IDs, so they are safe to apply from any copy.
  decisions = (sheet('Possible duplicates') || []).filter(r => String(r.Decision || '').trim());
  if (sheetPapers && (exportId === db.lastExportId || (!db.lastExportId && !db.papers.length))) {
    // The workbook is the latest export (or there is no database yet): take its rows as the user left them.
    papers = sheetPapers.filter(r => r.Title || r['Paper ID']).map(r => Object.fromEntries(PAPER_COLS.map(c => [c, String(r[c] ?? '')])));
    const gone = db.papers.length - papers.length;
    if (gone > 0) notes.push(`${gone} row${gone === 1 ? ' was' : 's were'} deleted from papers.xlsx since the last run; those papers are now ignored.`);
  } else if (sheetPapers && exportId !== db.lastExportId) {
    notes.push(`papers.xlsx is not the latest export (it says ${exportId || 'nothing'}, the database expects ${db.lastExportId}), so row edits in it were not applied. Duplicate decisions were. Download the current papers.xlsx before editing.`);
  }
  if (decisions.length) notes.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} on possible duplicates applied.`);
}
log(`${papers.length} papers already tracked; ${db.ledger.length} identifiers in the ledger.`);
for (const n of notes) log(n);

// ── Fetch ──
const paused = new Map();
events.addEventListener('wait', e => log(`   waiting ${Math.round(e.detail.ms / 1000)} s for ${e.detail.host} (${e.detail.why})`));
const fetched = [];
let next = 0, done = 0;
async function worker() {
  while (next < pis.length) {
    const pi = pis[next++];
    let res;
    try {
      res = await collectPapers(pi, { enabled: ENABLED, keys: KEYS, signal: undefined, paused });
    } catch (e) {
      res = { pi, results: {}, records: [], error: e.message };
    }
    done++;
    const statuses = Object.entries(res.results).map(([id, r]) => `${id}:${r.status}`).join(' ');
    const answered = Object.values(res.results).some(r => r.status === 'found' || r.status === 'none');
    fetched.push({
      pi: { ...pi, orcid: res.pi?.orcid || pi.orcid },
      records: res.records,
      ok: answered && !res.error,
      summary: res.error ? `error: ${res.error}` : `${res.records.length} records; ${statuses}`,
    });
    log(`[${done}/${pis.length}] ${pi.raw}: ${res.records.length} records  ${statuses}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const [id, msg] of paused) notes.push(`${SOURCES.find(s => s.id === id)?.label || id} was switched off partway: ${msg}`);

// ── Apply ──
const notifyAfter = new Date(NOW - NOTIFY_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
const result = applyRun({ papers, ledger: db.ledger, keptApart: db.keptApart, decisions }, fetched, { today: TODAY, notifyAfter });
for (const l of result.log) log(l);

// PI status
const prevPIs = new Map(db.pis.map(r => [piKey(r.PI), r]));
const piRows = new Map(prevPIs);
for (const f of fetched) {
  const k = piKey(f.pi.raw);
  const mine = result.papers.filter(p => piKey(p.PI) === k);
  const prev = prevPIs.get(k);
  piRows.set(k, {
    PI: f.pi.raw,
    Institution: f.pi.institution || '',
    ORCID: f.pi.orcid || prev?.ORCID || '',
    'Papers tracked': mine.length,
    'Newest paper': mine.map(p => p['Publication date']).sort((a, b) => dateKey(b).localeCompare(dateKey(a)))[0] || '',
    'First tracked': prev?.['First tracked'] || TODAY,
    'Last checked': TODAY,
    'Last result': f.ok ? f.summary : `no source answered; ${f.summary}`,
  });
}

// ── Save, then export ──
const byPI = (a, b) => String(a.PI).localeCompare(String(b.PI)) || dateKey(b['Publication date']).localeCompare(dateKey(a['Publication date']));
result.papers.sort(byPI);
store.save({
  papers: result.papers,
  ledger: result.ledger,
  keptApart: result.keptApart,
  pis: [...piRows.values()],
  run: { id: RUN_ID, at: NOW.toISOString(), pis: pis.length, papers: result.papers.length, fresh: result.fresh.length, published: result.published.length, notes: notes.join(' ') },
  exportId: RUN_ID,
});
store.close();
writeWorkbook(result, [...piRows.values()]);
log(`Saved ${result.papers.length} papers to ${rel(DB_FILE)} and ${rel(PAPERS_FILE)}; ${result.possible.length} possible duplicates to review.`);

// ── The notice ──
const fresh = result.fresh.slice().sort(byPI);
const published = result.published.slice().sort(byPI);
const count = fresh.length + published.length;
if (count) {
  const lines = [`Pub Tracker, ${TODAY}: **${fresh.length} new paper${fresh.length === 1 ? '' : 's'}**${published.length ? ` and **${published.length} newly published**` : ''}.`, ''];
  const block = (rows, heading) => {
    if (!rows.length) return;
    lines.push('', `## ${heading}`);
    let current = '';
    for (const r of rows) {
      if (r.PI !== current) { current = r.PI; lines.push('', `### ${r.PI}${r.Institution ? ` (${r.Institution})` : ''}`, ''); }
      const title = r.Link ? `[${r.Title.replace(/[[\]]/g, '')}](${r.Link})` : r.Title;
      lines.push(`- ${title}. ${[r['Journal / venue'], r['Publication date']].filter(Boolean).join(', ')}. Found in ${r['Found in']}; confidence ${r.Confidence}.${r['Other versions'] ? ` Earlier version: ${r['Other versions']}.` : ''}`);
    }
  };
  block(fresh, 'New papers');
  block(published, 'Preprints now published');
  lines.push('');
  if (result.possible.length) lines.push(`${result.possible.length} possible duplicate${result.possible.length === 1 ? ' is' : 's are'} waiting for review in the "Possible duplicates" sheet.`);
  for (const n of notes) lines.push('', `_${n}_`);
  lines.push('', 'The full list is in `data/papers.xlsx`.');
  fs.writeFileSync(NEW_FILE, lines.join('\n'));
  log(`${count} papers to report (${rel(NEW_FILE)}).`);
} else {
  if (fs.existsSync(NEW_FILE)) fs.rmSync(NEW_FILE);
  log('No new papers to report.');
}
setOutput('new_count', String(count));
setOutput('new_file', rel(NEW_FILE));
summary(`Pub Tracker: ${pis.length} PIs, ${result.papers.length} papers tracked, ${fresh.length} new, ${published.length} newly published, ${result.possible.length} possible duplicates to review.${notes.length ? '\n\n' + notes.join('\n\n') : ''}`);

// ── Helpers ──
function writeWorkbook(res, piList) {
  const link = (text, url) => (url ? { v: text || url, t: 's', l: { Target: url } } : { v: text || '', t: 's' });
  const sheet = (header, rows, widths, cell = (c, r) => r[c] ?? '') => {
    const aoa = [header, ...rows.map(r => header.map(c => cell(c, r)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = widths.map(w => ({ wch: w }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(1, aoa.length - 1), c: header.length - 1 } }) };
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(PAPER_COLS, res.papers, [10, 24, 26, 60, 14, 30, 28, 36, 30, 30, 11, 12, 20], (c, r) =>
    c === 'Title' ? link(r.Title, r.Link) : c === 'Link' ? link(r.Link, r.Link) : c === 'PI ORCID' && r[c] ? link(r[c], `https://orcid.org/${r[c]}`) : r[c] ?? ''), 'Papers');
  XLSX.utils.book_append_sheet(wb, sheet(DUP_COLS, res.possible, [22, 10, 50, 12, 26, 10, 50, 12, 26, 40, 12]), 'Possible duplicates');
  const PI_COLS = ['PI', 'Institution', 'ORCID', 'Papers tracked', 'Newest paper', 'First tracked', 'Last checked', 'Last result'];
  XLSX.utils.book_append_sheet(wb, sheet(PI_COLS, piList.sort((a, b) => String(a.PI).localeCompare(String(b.PI))), [24, 26, 20, 14, 14, 13, 13, 70]), 'PIs');
  const about = XLSX.utils.aoa_to_sheet([
    ['Pub Tracker: your institution\'s papers'],
    ['Export ID', RUN_ID],
    ['Run date', TODAY],
    ['PIs', pis.length],
    ['Papers', res.papers.length],
    ['Sources', [...ENABLED].map(id => SOURCES.find(s => s.id === id)?.label || id).join(', ')],
    [],
    ['How to review'],
    ['Delete a row', 'Removes that paper for good (it is remembered as ignored, so it never comes back).'],
    ['Possible duplicates', 'Write "same" in Decision to merge B into A, or "different" to keep both and stop asking.'],
    ['Same Paper ID', 'Giving two rows the same Paper ID also merges them.'],
    ['Then', 'Upload this file back to data/papers.xlsx. Edits apply on the next run. Edit only the latest export (the Export ID above must match).'],
    [],
    ['About the data'],
    ['Paper ID', 'Our own stable identifier. A paper is recognised by any of its identifiers: each source\'s own id, its DOI(s), or its title, so papers without a DOI are tracked too.'],
    ['Other versions', 'Other DOIs for the same paper, such as the preprint of a published article.'],
    ['First seen', 'The run that first found the paper. Rows are never deleted by the tracker.'],
    ['Confidence', 'High = two or more sources, or the ORCID iD came from the PI list; Medium = one source matched by ORCID or name + institution; Low = name only, check it.'],
    ['Only papers', 'Articles, preprints, conference papers, reviews, books, chapters, reports and theses. Not datasets, software, posters or talks.'],
    [],
    ['https://github.com/AI4RA/pub-tracker'],
  ]);
  about['!cols'] = [{ wch: 22 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, about, 'About');
  XLSX.writeFile(wb, PAPERS_FILE);
}

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
