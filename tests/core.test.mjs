// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRun } from '../tracker/core.mjs';

const PI = { raw: 'Robison, Barrie', institution: 'University of Idaho', orcid: '0000-0003-4458-926X' };
const rec = (source, sid, title, date, doi = '', venue = '') =>
  ({ source, sid, sourceLabel: { openalex: 'OpenAlex', pubmed: 'PubMed', orcid: 'ORCID', s2: 'Semantic Scholar' }[source], title, date, doi, venue, url: doi ? `https://doi.org/${doi}` : '', matchNote: 'Matched by name + institution' });

const T1 = 'Is evolution predictable? Experiments in an evolutionary video game';
const T2 = 'Genomic surveillance identifies potential risk factors for SARS-CoV-2 transmission';
const T3 = 'Coevolution of predators and prey in a digital ecosystem';

const run1 = [
  rec('openalex', 'W1', T1, '2025-11-28', '10.1101/2025.11.27.691019', 'bioRxiv'),      // preprint
  rec('orcid', 'X/1', T1.toUpperCase(), '2025-11', '10.1101/2025.11.27.691019'),        // same, by DOI
  rec('pubmed', '111', T2 + '.', '2023-06-19', '', 'Scientific reports'),               // no DOI
  rec('openalex', 'W2', T2, '2023-06-19', '10.1038/s41598-023-36000-1', 'Scientific Reports'),
  rec('openalex', 'W3', T3, '2021-04-01', '10.1162/artl_a_00001', 'Artificial Life'),
];
const go = (state, records, today, notifyAfter = '2000-01-01') =>
  applyRun(state, [{ pi: PI, records, ok: true }], { today, notifyAfter });
const keep = r => ({ papers: r.papers, ledger: r.ledger, keptApart: r.keptApart, decisions: [] });

test('first run is a baseline: one row per paper, nothing announced', () => {
  const r = go({}, run1, '2026-01-05');
  assert.equal(r.papers.length, 3);
  assert.equal(r.fresh.length, 0);
  const p2 = r.papers.find(p => p.Title.startsWith('Genomic'));
  assert.equal(p2.DOI, '10.1038/s41598-023-36000-1');
  assert.match(p2['Found in'], /OpenAlex/);
  assert.match(p2['Found in'], /PubMed/);
});

test('a second identical run adds nothing', () => {
  const r1 = go({}, run1, '2026-01-05');
  const r2 = go(keep(r1), run1, '2026-01-12');
  assert.equal(r2.papers.length, 3);
  assert.equal(r2.fresh.length, 0);
});

test('new papers are announced; late-indexed old ones are added quietly', () => {
  const r1 = go({}, run1, '2026-01-05');
  const r2 = go(keep(r1), [...run1,
    rec('openalex', 'W9', 'Brand new findings on fitness landscapes in games', '2026-01-08', '10.5555/new'),
    rec('pubmed', '999', 'An old paper that PubMed only just indexed for this author', '2019-03-01'),
  ], '2026-01-12', '2025-01-12');
  assert.equal(r2.papers.length, 5);
  assert.deepEqual(r2.fresh.map(p => p.DOI), ['10.5555/new']);
});

test('the same new paper from two sources becomes one row', () => {
  const r1 = go({}, run1, '2026-01-05');
  const r2 = go(keep(r1), [...run1,
    rec('openalex', 'W9', 'Brand new findings on fitness landscapes in games', '2026-01-08', '10.5555/new'),
    rec('s2', 'S9', 'Brand New Findings on Fitness Landscapes in Games', '2026-01-08', ''),
  ], '2026-01-12');
  assert.equal(r2.papers.length, 4);
  assert.equal(r2.fresh.length, 1);
  assert.match(r2.fresh[0]['Found in'], /Semantic Scholar/);
});

test('a deleted row stays deleted', () => {
  const r1 = go({}, run1, '2026-01-05');
  const papers = r1.papers.filter(p => !p.Title.startsWith('Coevolution'));
  const r2 = go({ ...keep(r1), papers }, run1, '2026-01-12');
  assert.equal(r2.papers.length, 2);
  assert.ok(r2.ledger.some(e => e.Status === 'ignored'));
  const r3 = go(keep(r2), run1, '2026-01-19');
  assert.equal(r3.papers.length, 2, 'still gone a week later');
});

test('a preprint that gets published updates its row and is announced', () => {
  const r1 = go({}, run1, '2026-01-05');
  const pre = r1.papers.find(p => p.Title.toLowerCase().startsWith('is evolution'));
  assert.equal(pre.DOI, '10.1101/2025.11.27.691019');
  const r2 = go(keep(r1), [...run1, rec('openalex', 'W7', T1, '2026-03-02', '10.1093/evolut/qpaf999', 'Evolution')], '2026-03-09');
  const row = r2.papers.find(p => p['Paper ID'] === pre['Paper ID']);
  assert.equal(row.DOI, '10.1093/evolut/qpaf999');
  assert.match(row['Other versions'], /10\.1101\/2025\.11\.27\.691019/);
  assert.equal(r2.papers.length, 3);
  assert.equal(r2.published.length, 1);
  assert.equal(r2.fresh.length, 0);
});

test('possible duplicates: "same" merges, "different" is remembered', () => {
  const near = [...run1,
    rec('openalex', 'W5', 'Measuring trust in science across rural communities', '2024-02-01', '10.5555/a'),
    rec('orcid', 'X/5', 'Measuring trust in science across rural community', '2024-02-01', '10.5555/b'),
  ];
  const r1 = go({}, near, '2026-01-05');
  assert.equal(r1.papers.length, 5);
  assert.equal(r1.possible.length, 1);
  const dup = r1.possible[0];

  const merged = go({ ...keep(r1), decisions: [{ ...dup, Decision: 'same' }] }, near, '2026-01-12');
  assert.equal(merged.papers.length, 4);
  assert.equal(merged.possible.length, 0);
  const again = go(keep(merged), near, '2026-01-19');
  assert.equal(again.papers.length, 4, 'merge sticks');

  const apart = go({ ...keep(r1), decisions: [{ ...dup, Decision: 'different' }] }, near, '2026-01-12');
  assert.equal(apart.papers.length, 5);
  assert.equal(apart.possible.length, 0, 'not flagged again');
});

test('giving two rows the same Paper ID by hand merges them', () => {
  const near = [...run1,
    rec('openalex', 'W5', 'Measuring trust in science across rural communities', '2024-02-01', '10.5555/a'),
    rec('orcid', 'X/5', 'Measuring trust in science across rural community', '2024-02-01', '10.5555/b'),
  ];
  const r1 = go({}, near, '2026-01-05');
  const { 'Paper ID A': A, 'Paper ID B': B } = r1.possible[0];
  const papers = r1.papers.map(p => (p['Paper ID'] === B ? { ...p, 'Paper ID': A } : p));
  const r2 = go({ ...keep(r1), papers }, near, '2026-01-12');
  assert.equal(r2.papers.length, 4);
  const row = r2.papers.find(p => p['Paper ID'] === A);
  assert.match(`${row.DOI}; ${row['Other versions']}`, /10\.5555\/a/);
  assert.match(`${row.DOI}; ${row['Other versions']}`, /10\.5555\/b/);
  assert.equal(go(keep(r2), near, '2026-01-19').papers.length, 4, 'and it sticks');
});

test('a PI added later is baselined, not announced', () => {
  const r1 = go({}, run1, '2026-01-05');
  const other = { raw: 'Baumgaertner, Bert', institution: 'University of Idaho', orcid: '' };
  const r2 = applyRun(keep(r1), [
    { pi: PI, records: run1, ok: true },
    { pi: other, records: [rec('openalex', 'W50', 'Patterns between evidence seeking behaviors and reasoning', '2026-06-25', '10.1371/x')], ok: true },
  ], { today: '2026-07-01', notifyAfter: '2025-07-01' });
  assert.equal(r2.fresh.length, 0);
  assert.equal(r2.papers.length, 4);
});
