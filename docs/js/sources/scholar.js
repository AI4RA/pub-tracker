// Google Scholar has no public API and refuses requests from other websites,
// so a page in the browser cannot read it, and this site sends nothing through
// a server of its own. Instead each PI gets a ready-made Google Scholar search,
// sorted by date, that the user can open with one click to check the result.

export const id = 'scholar';
export const label = 'Google Scholar';

export function searchUrl(pi) {
  const q = `author:"${pi.name.first} ${pi.name.last}"`;
  const p = new URLSearchParams({ q, scisbd: '1', hl: 'en' });
  return `https://scholar.google.com/scholar?${p}`;
}

export function profileSearchUrl(pi) {
  const q = [pi.name.full, pi.institution].filter(Boolean).join(' ');
  return `https://scholar.google.com/citations?${new URLSearchParams({ view_op: 'search_authors', mauthors: q, hl: 'en' })}`;
}

export async function lookup(pi) {
  return {
    status: 'link',
    url: profileSearchUrl(pi),
    note: 'Google Scholar cannot be queried from a web page; open the link to check by hand',
  };
}
