// Key manager: API keys and contact email for the bibliographic sources.
//
// Every key is optional. Keys live in sessionStorage only: tab-scoped, never
// written to disk, and wiped on every page load so a reload starts clean.
// Keys can also arrive as URL params (?openalex=...&s2=...) and are stripped
// from the address bar as soon as they are read.

const PREFIX = 'pubtracker_';

export const KEY_FIELDS = [
  { id: 'email',    param: 'email',    label: 'Contact email',
    help: 'Sent to OpenAlex and PubMed as the contact they ask heavy users for, so they can reach you instead of blocking you. Optional.' },
  { id: 'openalex', param: 'openalex', label: 'OpenAlex API key',
    help: 'Free at openalex.org/settings/api. Without one, requests share a small daily budget with everyone on your network.' },
  { id: 's2',       param: 's2',       label: 'Semantic Scholar API key',
    help: 'Free on request at semanticscholar.org/product/api. Without one, requests share a public pool and are often throttled.' },
  { id: 'ncbi',     param: 'ncbi',     label: 'NCBI (PubMed) API key',
    help: 'Free from your NCBI account settings. Raises the limit from 3 to 10 requests per second.' },
];

export function getKey(id) {
  return (sessionStorage.getItem(PREFIX + id) || '').trim();
}

export function setKey(id, value) {
  const v = (value || '').trim();
  if (v) sessionStorage.setItem(PREFIX + id, v);
  else sessionStorage.removeItem(PREFIX + id);
}

export function allKeys() {
  const out = {};
  for (const f of KEY_FIELDS) out[f.id] = getKey(f.id);
  return out;
}

export function readKeysFromURL() {
  for (const f of KEY_FIELDS) sessionStorage.removeItem(PREFIX + f.id);
  const url = new URL(window.location);
  let changed = false;
  for (const f of KEY_FIELDS) {
    const v = url.searchParams.get(f.param);
    if (v) {
      setKey(f.id, v);
      url.searchParams.delete(f.param);
      changed = true;
    }
  }
  if (changed) window.history.replaceState({}, '', url);
  return allKeys();
}
