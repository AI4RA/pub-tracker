// Read an uploaded CSV/XLSX into rows, guess the columns, and write the
// results workbook. Uses SheetJS (global XLSX), loaded from a CDN.

import { SOURCES } from './lookup.js';
import { searchUrl } from './sources/scholar.js';

export async function readTable(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', raw: false, codepage: 65001 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows: rows.filter(r => Object.values(r).some(v => String(v).trim())) };
}

const GUESS = {
  name: [/^(pi|investigator|researcher|faculty|author)?\s*(full\s*)?name$/i, /^pi$/i, /principal investigator/i, /\bname\b/i],
  first: [/^first(\s*name)?$/i, /^given(\s*name)?$/i, /^fname$/i],
  last: [/^last(\s*name)?$/i, /^surname$/i, /^family(\s*name)?$/i, /^lname$/i],
  institution: [/institution/i, /affiliation/i, /university/i, /organi[sz]ation/i, /^org$/i],
  orcid: [/orcid/i],
};

export function guessColumns(headers) {
  const pick = (pats, exclude = []) => {
    for (const p of pats) {
      const h = headers.find(h => p.test(h.trim()) && !exclude.includes(h));
      if (h) return h;
    }
    return '';
  };
  const first = pick(GUESS.first);
  const last = pick(GUESS.last);
  const split = Boolean(first && last);
  const name = split ? '' : (pick(GUESS.name, [first, last]) || headers[0] || '');
  return {
    name,
    first: split ? first : '',
    last: split ? last : '',
    institution: pick(GUESS.institution),
    orcid: pick(GUESS.orcid),
  };
}

function link(text, url) {
  return url ? { v: text || url, t: 's', l: { Target: url, Tooltip: url } } : { v: text || '', t: 's' };
}

export function writeWorkbook(records, meta) {
  const wb = XLSX.utils.book_new();
  const lookupSources = SOURCES.filter(s => s.id !== 'scholar' && meta.enabled.has(s.id));

  // Sheet 1: one row per PI.
  const head = ['PI', 'Institution', 'Most recent paper', 'Publication date', 'Journal / venue', 'DOI', 'Link',
    'Found by', 'Sources agreeing', 'Confidence', 'ORCID', 'Google Scholar search', 'Notes'];
  const aoa = [head];
  for (const rec of records) {
    const b = rec.best;
    const orcidId = rec.pi.orcid || Object.values(rec.results).find(r => r?.orcid)?.orcid || '';
    const notes = lookupSources.map(s => {
      const r = rec.results[s.id];
      return r ? `${s.label}: ${r.status === 'found' ? r.note : (r.note || r.status)}` : '';
    }).filter(Boolean).join(' | ');
    aoa.push([
      rec.pi.raw,
      rec.pi.institution || '',
      b ? link(b.title, b.url) : 'No paper found',
      b?.date || '',
      b?.venue || '',
      b?.doi || '',
      b ? link(b.url, b.url) : '',
      b?.source || '',
      b ? b.agreeing.join(', ') : '',
      b?.confidence || '',
      orcidId ? link(orcidId, `https://orcid.org/${orcidId}`) : '',
      meta.enabled.has('scholar') ? link('Search', searchUrl(rec.pi)) : '',
      notes,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [24, 26, 60, 14, 30, 28, 36, 16, 26, 11, 22, 14, 80].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: head.length - 1 } }) };
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, 'Most recent paper');

  // Sheet 2: one row per PI per source, so each source's answer can be checked.
  const head2 = ['PI', 'Source', 'Status', 'Paper', 'Publication date', 'Journal / venue', 'DOI', 'Link', 'Author profile', 'How matched'];
  const aoa2 = [head2];
  for (const rec of records) {
    for (const s of SOURCES.filter(s => meta.enabled.has(s.id))) {
      const r = rec.results[s.id];
      if (!r) continue;
      aoa2.push([
        rec.pi.raw, s.label, r.status,
        r.title ? link(r.title, r.url) : '',
        r.date || '', r.venue || '', r.doi || '',
        r.url ? link(r.url, r.url) : '',
        r.authorUrl ? link(r.authorUrl, r.authorUrl) : '',
        r.note || '',
      ]);
    }
  }
  const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
  ws2['!cols'] = [24, 16, 9, 60, 14, 30, 28, 36, 36, 60].map(w => ({ wch: w }));
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa2.length - 1, c: head2.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws2, 'By source');

  // Sheet 3: how the file was made.
  const about = [
    ['Pub Tracker results'],
    ['Generated', new Date().toLocaleString()],
    ['PIs', records.length],
    ['Default institution', meta.defaultInstitution || '(none)'],
    ['Sources', SOURCES.filter(s => meta.enabled.has(s.id)).map(s => s.label).join(', ')],
    [],
    ['How the most recent paper is chosen'],
    ['Each source is searched for the PI. The newest paper with a publication date on or before today wins; papers dated in the future (forthcoming issues) are skipped.'],
    ['"Sources agreeing" lists every source whose newest paper has the same DOI or title.'],
    ['Confidence: High = two or more sources agree, or the ORCID iD came from your file. Medium = one source, matched by ORCID or by name plus institution. Low = matched by name only; check it.'],
    ['Google Scholar cannot be searched from a web page, so the "Google Scholar search" link opens a date-sorted search to check by hand.'],
    ['Common names can match the wrong person. Adding an institution or ORCID column to your file gives the best matches.'],
    [],
    ['Pub Tracker', 'https://ui-insight.github.io/pub-tracker/'],
    ['A partnership of the University of Idaho, Idaho State University, and AI4RA (NSF award 2427549).'],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(about);
  ws3['!cols'] = [{ wch: 22 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'About');

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `pub-tracker-${stamp}.xlsx`);
}

export function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['PI Name', 'Institution', 'ORCID'],
    ['Lastname, Firstname', 'Idaho State University', ''],
    ['Firstname M. Lastname', 'University of Idaho', ''],
  ]);
  ws['!cols'] = [{ wch: 26 }, { wch: 28 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws, 'PIs');
  XLSX.writeFile(wb, 'pub-tracker-template.xlsx');
}
