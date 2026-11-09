// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRecords, groupRecords, samePaper, jaroWinkler, normTitle, representative, isPreprint } from '../docs/js/linkage.js';

const journal = { title: 'Density dependence affects population recovery following an epizootic', date: '2025-12-15', venue: 'Ecology Letters', doi: '10.1111/ele.70001' };
const pubmed = { title: 'Density dependence affects population <i>recovery</i> following an epizootic.', date: '2025-12', venue: 'Ecol Lett', doi: '' };
const orcidUpper = { title: 'DENSITY DEPENDENCE AFFECTS POPULATION RECOVERY FOLLOWING AN EPIZOOTIC', date: '2025', doi: 'https://doi.org/10.1111/ELE.70001' };
const preprint = { title: 'Density dependence affects population recovery following an epizootic', date: '2024-11-02', venue: 'bioRxiv', doi: '10.1101/2024.11.01.621111' };
const correction = { title: 'Correction to: Density dependence affects population recovery following an epizootic', date: '2026-02-01', doi: '10.1111/ele.70099' };
const part1 = { title: 'Modeling wildfire smoke exposure in rural Idaho: Part I, methods', date: '2023-05-01' };
const part2 = { title: 'Modeling wildfire smoke exposure in rural Idaho: Part II, methods', date: '2023-08-01' };
const reworded1 = { title: 'Is evolution predictable? Experiments in an evolutionary video game', date: '2025-11-28' };
const reworded2 = { title: 'Is evolution predictable? Experiments with an evolutionary video game', date: '2025-11' };
const reused = { title: 'Density dependence affects population recovery following an epizootic', date: '2019-01-01' };

test('cleans titles and scores similarity', () => {
  assert.equal(normTitle('A <i>Study</i> of &amp; Things.'), 'a study of things');
  assert.ok(jaroWinkler('martha', 'marhta') > 0.96);
});

test('same paper across sources, formatting and versions', () => {
  assert.equal(compareRecords(journal, pubmed).verdict, 'same');
  assert.equal(compareRecords(journal, orcidUpper).verdict, 'same', 'DOI case and URL prefix');
  assert.equal(compareRecords(journal, preprint).verdict, 'same', 'preprint a year earlier');
});

test('never the same', () => {
  assert.equal(compareRecords(journal, correction).verdict, 'different');
  assert.equal(compareRecords(part1, part2).verdict, 'different');
  assert.equal(compareRecords({ title: 'Editorial', date: '2024' }, { title: 'Editorial', date: '2024' }).verdict, 'different');
});

test('uncertain cases go to review', () => {
  assert.equal(compareRecords(reworded1, reworded2).verdict, 'maybe');
  assert.equal(compareRecords(journal, reused).verdict, 'maybe', 'same title six years apart');
});

test('groups records into papers', () => {
  const groups = groupRecords([journal, pubmed, orcidUpper, preprint, correction, part1, part2]);
  assert.equal(groups.length, 4);
});

test('representative prefers the published version', () => {
  assert.equal(representative([preprint, pubmed, journal]).doi, '10.1111/ele.70001');
  assert.ok(isPreprint(preprint));
  assert.ok(!isPreprint(journal));
  assert.ok(samePaper(journal, orcidUpper));
});
