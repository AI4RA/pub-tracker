# Pub Tracker

Upload a spreadsheet of principal investigators and get back an Excel file with each PI's most recent paper: title (linked), date, journal, DOI, which sources found it, and a confidence level. Pub Tracker searches **OpenAlex**, **Semantic Scholar**, **PubMed**, and **ORCID**, and gives a **Google Scholar** link for each PI to check by hand.

Everything runs in your browser. There is no server of ours in the middle: the file is read locally, your browser calls each database directly, and the workbook is built locally.

**Live:** [ui-insight.github.io/pub-tracker](https://ui-insight.github.io/pub-tracker/)

## How it works

1. **Upload** a `.csv` or `.xlsx` with one row per PI. A name column is enough (`Last, First`, `First Last`, or separate first and last columns). An **Institution** column (or one default institution for the whole list) and **ORCID** iDs make matches much more reliable.
2. **Check the columns** Pub Tracker guessed.
3. **Search.** For each PI:
   - **ORCID** is searched first by name and institution. An iD tied to the institution is passed to OpenAlex and Semantic Scholar for an exact match.
   - **OpenAlex** looks for authors with that name who have been affiliated with the institution, then takes their newest work by publication date.
   - **Semantic Scholar** ranks authors by name, affiliation and paper count, then sorts their papers by date.
   - **PubMed** searches the full author name with the institution in the affiliation field, and falls back to surname + first initial within that affiliation.
   - When an institution is given, a source reports "not found" rather than guess among namesakes elsewhere.
4. **Download** the `.xlsx`:
   - **Most recent paper**: one row per PI, with the newest paper dated on or before today across all sources, the sources that agree with it, confidence, ORCID, and a Google Scholar search link.
   - **By source**: each source's answer for each PI and how it matched, for auditing.
   - **About**: when and how the file was made.

**Confidence:** *High* means two or more sources report the same paper, or the ORCID iD came from your file. *Medium* means one source, matched by ORCID or by name plus institution. *Low* means a name-only match; check it.

## Data privacy

No data goes to our servers; we don't run any. Only each PI's name, institution and ORCID iD are sent, directly from your browser, to the public databases you tick. Other columns in your file are never read. Google Scholar is contacted only if you click a link. There are no cookies, accounts or analytics. The **Data privacy** button on the site has the details.

## Why Google Scholar is a link

Google Scholar has no public API and blocks requests from other websites, and so do the paid services that scrape it (such as SerpAPI). Querying it would need a server in the middle, which would break the promise above. So each PI gets a one-click, date-sorted Google Scholar search instead.

## API keys (optional)

Pub Tracker works with no keys. A free key of your own raises a service's limits, which helps with long lists. Open **API Keys** on the site, or pass them in the URL (read once, then stripped from the address bar): `?openalex=…&s2=…&ncbi=…&email=…`. Keys are held in `sessionStorage` and cleared when you close or reload the tab, and each goes only to the service that issued it.

| Key | Where | Without it |
|---|---|---|
| OpenAlex | [openalex.org/settings/api](https://openalex.org/settings/api) (free) | Shares $0.10/day of usage with everyone on your network, about 100 PIs a day |
| Semantic Scholar | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) (free, on request) | Shared public pool, about one request a second; sets the pace (~2 s per PI) |
| NCBI (PubMed) | [NCBI account settings](https://account.ncbi.nlm.nih.gov/settings/) (free) | 3 requests a second instead of 10 |
| Contact email | — | Sent to OpenAlex and PubMed as the contact they ask heavy users for |

## Run locally

```bash
python3 -m http.server 4173 -d docs
# open http://localhost:4173
```

## Contributing

Contributions are welcome by pull request. By submitting a contribution you agree that it will be licensed under the [Apache License, Version 2.0](LICENSE), the same license as the project, and you represent that you have the right to license it under those terms. Contributions keep the attribution in [NOTICE](NOTICE) intact.

## License

Copyright 2026 Nathan Layman and Stephen Wright.

Licensed under the [Apache License, Version 2.0](LICENSE). The [NOTICE](NOTICE) file credits Nathan Layman (University of Idaho) and Stephen Wright (Idaho State University) as the authors, the University of Idaho, Idaho State University, the AI4RA project, and the National Science Foundation award that funded the work. Under Section 4(d) of the license, anyone who redistributes this software or a derivative work must keep those attributions. To cite the project, use [CITATION.cff](CITATION.cff).

## Third-party software and data

| Library | Use | License |
|---|---|---|
| [SheetJS](https://github.com/SheetJS/sheetjs) 0.18.5 | Reading CSV/XLSX, writing XLSX | Apache-2.0 |

Data comes from [OpenAlex](https://openalex.org) (CC0), the [Semantic Scholar API](https://www.semanticscholar.org/product/api), [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/) (PubMed), and the [ORCID public API](https://info.orcid.org/documentation/features/public-api/), each under its own terms.

## Acknowledgments

Pub Tracker is a partnership of the University of Idaho, Idaho State University, and [AI4RA](https://github.com/AI4RA). This material is based upon work supported by the National Science Foundation under the GRANTED program, [NSF Award #2427549](https://www.nsf.gov/awardsearch/show-award?AWD_ID=2427549), "Crossing the Innovation Valley of Death: Democratizing Data and Artificial Intelligence for Research Administration." Any opinions, findings, conclusions or recommendations expressed in this material are those of the authors and do not necessarily reflect the views of the National Science Foundation.
