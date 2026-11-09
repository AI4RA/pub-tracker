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

**Pub Tracker works with no keys.** ORCID and Google Scholar never need one. Keys only raise limits for longer lists. As a rough guide, up to about 50 PIs runs fine with no keys; for a few hundred, get an OpenAlex key. If a source hits its limit mid-run, that source shows "Rate limit or daily budget reached" for the remaining PIs and the other sources carry on.

Add keys under **API Keys** on the site, or pass them in the URL (read once, then stripped from the address bar): `?openalex=…&s2=…&ncbi=…&email=…`. Keys are held in `sessionStorage`, cleared when you close or reload the tab, and each goes only to the service that issued it.

| Key | Without it | With it | How to get one |
|---|---|---|---|
| **OpenAlex** | $0.10/day of usage shared by everyone on your network: about 50 to 100 PIs | Your own $1/day: about 500 to 1,000 PIs | Free, about a minute. [Make an account](https://openalex.org/signup), click the link in the verification email (the key doesn't work until you do), then copy the key from [Settings → API key](https://openalex.org/settings/api-key). |
| **Semantic Scholar** | Shared public pool; slowed or refused at busy times | A steady 1 request/second of your own | Free, but reviewed by hand, so allow a few days to a few weeks. Fill in the [API key request form](https://www.semanticscholar.org/product/api#api-key-form) (name, email, institution, intended use); the key arrives by email. Until then, untick Semantic Scholar for big runs. |
| **NCBI (PubMed)** | 3 requests/second, usually enough | 10 requests/second | Free, instant. Sign in at [NCBI](https://account.ncbi.nlm.nih.gov/settings/) (Google, ORCID, Login.gov or many university logins work), open Account Settings → API Key Management, click **Create an API Key**. |
| **Contact email** | — | — | Your own address. Sent to OpenAlex and PubMed as the contact they ask heavy users for. |

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
