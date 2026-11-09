# data/

In your own private copy of Pub Tracker (see the [deploy guide](https://ai4ra.github.io/pub-tracker/deploy.html)):

- **`pis.xlsx`** (or `pis.csv`): your list of PIs, one row per person. You add this. A name column is required (`Last, First`, `First Last`, or separate first and last name columns); an `Institution` column and `ORCID` iDs make matching much more reliable. `pis.example.csv` shows the shape.
- **`papers.xlsx`**: written by the scheduled workflow. One row per PI + paper, never deleted, with the date each paper was first seen. Don't edit it by hand while a run might be going; edits to existing rows are overwritten with what the sources say on the next run.

This folder holds no PI data in the public AI4RA/pub-tracker repository, and the tracking workflow does not run there.
