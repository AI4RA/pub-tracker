// Pub Tracker: upload → map columns → look up each PI → download workbook.

import { KEY_FIELDS, getKey, setKey, readKeysFromURL, allKeys } from './keys.js';
import { readTable, guessColumns, writeWorkbook, downloadTemplate } from './io.js';
import { lookupPI, SOURCES } from './lookup.js';
import { parseName, normalizeOrcid } from './match.js';
import { searchUrl } from './sources/scholar.js';

const $ = id => document.getElementById(id);
const CONCURRENCY = 3;

const state = { headers: [], rows: [], records: [], running: false, controller: null };

// ── Modals ──
function wireModal(btnIds, modalId, closeId) {
  const modal = $(modalId);
  for (const b of btnIds) $(b)?.addEventListener('click', () => modal.classList.add('visible'));
  $(closeId).addEventListener('click', () => modal.classList.remove('visible'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('visible'); });
}
wireModal(['privacy-btn', 'privacy-link'], 'privacy-modal', 'privacy-close');
wireModal(['how-btn'], 'how-modal', 'how-close');
wireModal(['about-btn'], 'about-modal', 'about-close');
wireModal(['api-key-btn'], 'api-key-modal', 'api-key-close');
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.visible').forEach(m => m.classList.remove('visible'));
});

// ── Keys ──
readKeysFromURL();
const keyBox = $('key-fields');
for (const f of KEY_FIELDS) {
  const div = document.createElement('div');
  div.className = 'key-field';
  const lab = document.createElement('label');
  lab.htmlFor = `key-${f.id}`;
  lab.textContent = f.label;
  const input = document.createElement('input');
  input.id = `key-${f.id}`;
  input.type = f.id === 'email' ? 'email' : 'password';
  input.autocomplete = 'off';
  input.value = getKey(f.id);
  input.addEventListener('input', () => { setKey(f.id, input.value); updateKeyDot(); });
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = f.help;
  div.append(lab, input, hint);
  if (f.get) {
    const det = document.createElement('details');
    det.className = 'fine';
    const sum = document.createElement('summary');
    sum.textContent = 'How to get one';
    const ol = document.createElement('ol');
    for (const step of f.get.steps) ol.append(Object.assign(document.createElement('li'), { textContent: step }));
    const p = document.createElement('p');
    const a = Object.assign(document.createElement('a'), { href: f.get.url, target: '_blank', rel: 'noopener', textContent: f.get.linkText });
    p.append('Start here: ', a, `. ${f.get.time}`);
    det.append(sum, p, ol);
    div.append(det);
  }
  keyBox.append(div);
}
function updateKeyDot() {
  const k = allKeys();
  $('api-key-dot').classList.toggle('connected', Boolean(k.openalex || k.s2 || k.ncbi));
}
updateKeyDot();

// ── Sources ──
const DEFAULT_ON = new Set(SOURCES.map(s => s.id));
const srcBox = $('sources');
for (const s of SOURCES) {
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = s.id;
  cb.checked = DEFAULT_ON.has(s.id);
  lab.append(cb, document.createTextNode(s.label));
  if (s.id === 'scholar') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '(link to check by hand)';
    lab.append(tag);
  }
  srcBox.append(lab);
}
const enabledSources = () => new Set([...srcBox.querySelectorAll('input:checked')].map(c => c.value));

// ── Upload ──
const drop = $('drop-zone');
const fileInput = $('file-input');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
$('template-btn').addEventListener('click', e => { e.preventDefault(); downloadTemplate(); });

async function loadFile(file) {
  try {
    const { headers, rows } = await readTable(file);
    if (!rows.length) throw new Error('No rows found in the first sheet.');
    state.headers = headers;
    state.rows = rows;
    $('file-name').textContent = `${file.name}: ${rows.length} row${rows.length === 1 ? '' : 's'}`;
    fillColumnSelects(guessColumns(headers));
    $('step-columns').classList.remove('disabled');
    $('step-run').classList.remove('disabled');
    resetResults();
  } catch (e) {
    $('file-name').textContent = `Could not read that file: ${e.message}`;
  }
}

const COLS = { name: 'col-name', first: 'col-first', last: 'col-last', institution: 'col-inst', orcid: 'col-orcid' };
function fillColumnSelects(guess) {
  for (const [k, id] of Object.entries(COLS)) {
    const sel = $(id);
    sel.innerHTML = '';
    sel.append(new Option('(none)', ''));
    for (const h of state.headers) sel.append(new Option(h, h));
    sel.value = guess[k] || '';
  }
  updatePreview();
}
Object.values(COLS).forEach(id => $(id).addEventListener('change', updatePreview));
$('default-inst').addEventListener('input', updatePreview);

function buildPIs() {
  const c = Object.fromEntries(Object.entries(COLS).map(([k, id]) => [k, $(id).value]));
  const defInst = $('default-inst').value.trim();
  const useSplit = !c.name && c.first && c.last;
  return state.rows.map(r => {
    const raw = useSplit ? `${r[c.first]} ${r[c.last]}`.trim() : String(r[c.name] || '').trim();
    const name = useSplit ? parseName('', r[c.first], r[c.last]) : parseName(raw);
    return {
      raw,
      name,
      institution: (c.institution && String(r[c.institution] || '').trim()) || defInst,
      orcid: c.orcid ? normalizeOrcid(r[c.orcid]) : '',
    };
  }).filter(p => p.name && p.name.last);
}

function updatePreview() {
  const pis = buildPIs();
  const ex = pis.slice(0, 3).map(p => `${p.name.first} ${p.name.last}${p.institution ? ` (${p.institution})` : ''}`).join('; ');
  const noInst = pis.filter(p => !p.institution).length;
  $('preview').textContent = pis.length
    ? `${pis.length} PIs read as, for example: ${ex}.${noInst ? ` ${noInst} have no institution, so they are matched by name only.` : ''}`
    : 'Pick the column that holds PI names.';
  $('run-btn').disabled = !pis.length;
}

// ── Run ──
function resetResults() {
  state.records = [];
  $('results-body').innerHTML = '';
  $('table-wrap').hidden = true;
  $('progress-wrap').hidden = true;
  $('download-btn').disabled = true;
}

$('run-btn').addEventListener('click', run);
$('stop-btn').addEventListener('click', () => state.controller?.abort());
$('download-btn').addEventListener('click', () => {
  writeWorkbook(state.records.filter(Boolean), { enabled: state.enabled, defaultInstitution: $('default-inst').value.trim() });
});

async function run() {
  const pis = buildPIs();
  const enabled = enabledSources();
  if (!pis.length || !enabled.size) return;
  resetResults();
  state.running = true;
  state.enabled = enabled;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  const keys = allKeys();

  $('run-btn').disabled = true;
  $('stop-btn').hidden = false;
  $('progress-wrap').hidden = false;
  $('table-wrap').hidden = false;
  document.querySelectorAll('#step-upload, #step-columns').forEach(el => el.classList.add('disabled'));

  const rows = pis.map(pi => addRow(pi));
  let done = 0;
  const started = Date.now();
  const tick = () => {
    $('progress-bar').style.width = `${(done / pis.length) * 100}%`;
    const per = done ? (Date.now() - started) / done : 0;
    const left = per ? Math.round((per * (pis.length - done)) / 1000) : 0;
    $('status-line').textContent = `${done} of ${pis.length} PIs searched${done && done < pis.length ? `, about ${fmtSecs(left)} left` : ''}.`;
  };
  tick();

  let next = 0;
  const worker = async () => {
    while (next < pis.length && !signal.aborted) {
      const i = next++;
      try {
        const rec = await lookupPI(pis[i], { enabled, keys, signal });
        state.records[i] = rec;
        fillRow(rows[i], rec);
      } catch (e) {
        if (e.name === 'AbortError') return;
        state.records[i] = { pi: pis[i], results: {}, best: null };
        fillRow(rows[i], state.records[i], e.message);
      }
      done++;
      tick();
      if (done > 0) $('download-btn').disabled = false;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  state.running = false;
  $('run-btn').disabled = false;
  $('stop-btn').hidden = true;
  document.querySelectorAll('#step-upload, #step-columns').forEach(el => el.classList.remove('disabled'));
  const found = state.records.filter(r => r?.best).length;
  $('status-line').textContent = `${signal.aborted ? 'Stopped. ' : ''}${done} of ${pis.length} PIs searched; a recent paper was found for ${found}.`;
  $('download-btn').disabled = done === 0;
}

function fmtSecs(s) {
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// ── Table rendering (textContent only; nothing from an API is parsed as HTML) ──
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids.filter(k => k != null && k !== ''));
  return e;
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}

function a(text, href, cls) {
  const h = safeHref(href);
  return h ? el('a', { href: h, target: '_blank', rel: 'noopener', textContent: text, className: cls || '' }) : el('span', { textContent: text, className: cls || '' });
}

function addRow(pi) {
  const tr = el('tr', { className: 'pending' });
  tr.append(
    el('td', {}, el('div', { textContent: pi.raw }), pi.institution ? el('div', { className: 'hint', textContent: pi.institution }) : null),
    el('td', { className: 'title', textContent: 'Waiting…' }),
    el('td'), el('td'), el('td'), el('td'),
  );
  $('results-body').append(tr);
  return tr;
}

function fillRow(tr, rec, error) {
  tr.className = '';
  const [, tdTitle, tdDate, tdVenue, tdConf, tdSrc] = tr.children;
  const b = rec.best;
  tdTitle.replaceChildren(b ? a(b.title || b.url, b.url) : el('span', { className: 'hint', textContent: error ? `Error: ${error}` : 'No paper found' }));
  tdDate.className = 'nowrap';
  tdDate.textContent = b?.date || '';
  tdVenue.textContent = b?.venue || '';
  tdConf.replaceChildren(b ? el('span', { className: `conf ${b.confidence}`, textContent: b.confidence, title: `Found by ${b.source}; agreeing: ${b.agreeing.join(', ')}` }) : '');
  const chips = el('div', { className: 'chips' });
  for (const s of SOURCES) {
    if (s.id === 'scholar') {
      if (state.enabled.has('scholar')) chips.append(a('Google Scholar ↗', searchUrl(rec.pi), 'chip link'));
      continue;
    }
    const r = rec.results[s.id];
    if (!r) continue;
    const label = r.status === 'found' ? `${s.label} ${r.date?.slice(0, 4) || ''}` : `${s.label}: ${r.status === 'none' ? 'none' : 'error'}`;
    const chip = r.url ? a(label, r.url, `chip ${r.status}`) : el('span', { className: `chip ${r.status}`, textContent: label });
    chip.title = [r.title, r.note].filter(Boolean).join('\n');
    chips.append(chip);
  }
  tdSrc.replaceChildren(chips);
}
