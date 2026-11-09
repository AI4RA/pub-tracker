// SQLite storage for the scheduled tracker (data/tracker.db), using Node's
// built-in node:sqlite, so there is nothing extra to install.
//
// The database is the system of record: papers, the ledger of every
// identifier ever seen, pairs a person decided are different papers, PI
// status, and a log of runs. data/papers.xlsx is rebuilt from it on every
// run for people to read and review.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  pi TEXT NOT NULL, paper_id TEXT NOT NULL, institution TEXT, title TEXT, pub_date TEXT, venue TEXT,
  doi TEXT, link TEXT, other_versions TEXT, found_in TEXT, confidence TEXT, first_seen TEXT, pi_orcid TEXT,
  PRIMARY KEY (pi, paper_id));
CREATE TABLE IF NOT EXISTS ledger (
  pi TEXT NOT NULL, key TEXT NOT NULL, paper_id TEXT NOT NULL, source TEXT, first_seen TEXT, status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (pi, key));
CREATE TABLE IF NOT EXISTS kept_apart (
  pi TEXT NOT NULL, paper_a TEXT NOT NULL, paper_b TEXT NOT NULL, decided TEXT,
  PRIMARY KEY (pi, paper_a, paper_b));
CREATE TABLE IF NOT EXISTS pis (
  pi TEXT PRIMARY KEY, institution TEXT, orcid TEXT, papers_tracked INTEGER, newest_paper TEXT,
  first_tracked TEXT, last_checked TEXT, last_result TEXT);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, ran_at TEXT, pis INTEGER, papers INTEGER, new_papers INTEGER, now_published INTEGER, notes TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

// Column names in the workbook <-> the database.
const PAPER_MAP = [
  ['PI', 'pi'], ['Paper ID', 'paper_id'], ['Institution', 'institution'], ['Title', 'title'], ['Publication date', 'pub_date'],
  ['Journal / venue', 'venue'], ['DOI', 'doi'], ['Link', 'link'], ['Other versions', 'other_versions'], ['Found in', 'found_in'],
  ['Confidence', 'confidence'], ['First seen', 'first_seen'], ['PI ORCID', 'pi_orcid'],
];
const LEDGER_MAP = [['PI', 'pi'], ['Key', 'key'], ['Paper ID', 'paper_id'], ['Source', 'source'], ['First seen', 'first_seen'], ['Status', 'status']];
const APART_MAP = [['PI', 'pi'], ['Paper ID A', 'paper_a'], ['Paper ID B', 'paper_b'], ['Decided', 'decided']];
const PI_MAP = [['PI', 'pi'], ['Institution', 'institution'], ['ORCID', 'orcid'], ['Papers tracked', 'papers_tracked'], ['Newest paper', 'newest_paper'],
  ['First tracked', 'first_tracked'], ['Last checked', 'last_checked'], ['Last result', 'last_result']];

const fromRow = (map, r) => Object.fromEntries(map.map(([k, c]) => [k, r[c] ?? '']));
const toRow = (map, o) => Object.fromEntries(map.map(([k, c]) => [c, o[k] ?? '']));

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const all = (sql, map) => db.prepare(sql).all().map(r => fromRow(map, r));
  const meta = k => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? '';

  function replace(table, map, rows) {
    db.exec(`DELETE FROM ${table}`);
    const cols = map.map(([, c]) => c);
    const ins = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const o of rows) {
      const r = toRow(map, o);
      ins.run(...cols.map(c => (typeof r[c] === 'number' ? r[c] : String(r[c] ?? ''))));
    }
  }

  return {
    load() {
      return {
        papers: all('SELECT * FROM papers', PAPER_MAP),
        ledger: all('SELECT * FROM ledger', LEDGER_MAP),
        keptApart: all('SELECT * FROM kept_apart', APART_MAP),
        pis: all('SELECT * FROM pis', PI_MAP),
        lastExportId: meta('last_export_id'),
      };
    },
    // Everything in one transaction: a failed run leaves the database as it was.
    save({ papers, ledger, keptApart, pis, run, exportId }) {
      db.exec('BEGIN');
      try {
        replace('papers', PAPER_MAP, papers);
        replace('ledger', LEDGER_MAP, ledger);
        replace('kept_apart', APART_MAP, keptApart);
        replace('pis', PI_MAP, pis);
        db.prepare('INSERT OR REPLACE INTO runs (run_id, ran_at, pis, papers, new_papers, now_published, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(run.id, run.at, run.pis, run.papers, run.fresh, run.published, run.notes || '');
        db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_export_id', ?)").run(exportId);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      db.exec('VACUUM');
    },
    close() { db.close(); },
  };
}
