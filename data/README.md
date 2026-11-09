# data/

In your own private copy of Pub Tracker (see the [deploy guide](https://ai4ra.github.io/pub-tracker/deploy.html)):

- **`pis.xlsx`** (or `pis.csv`): your list of PIs, one row per person. You add this. A name column is required (`Last, First`, `First Last`, or separate first and last name columns); an `Institution` column and `ORCID` iDs make matching much more reliable. `pis.example.csv` shows the shape.
- **`tracker.db`**: SQLite, written by the scheduled workflow. The permanent record: every paper with its stable Paper ID, the ledger of every identifier seen for it, your review decisions, PI status, and a log of runs. Don't edit it by hand.
- **`papers.xlsx`**: rebuilt from the database each run, for review. Delete a row to drop a paper for good; under "Possible duplicates" write `same` or `different` in the Decision column. Upload it back here; the next run applies your changes. Only edit the latest copy.

The public AI4RA/pub-tracker repository holds no PI data, and the tracking workflow does not run there.
