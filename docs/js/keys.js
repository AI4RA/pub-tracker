// Key manager: API keys and contact email for the bibliographic sources.
//
// Every key is optional. Keys live in sessionStorage only: tab-scoped, never
// written to disk, and wiped on every page load so a reload starts clean.
// Keys can also arrive as URL params (?openalex=...&s2=...) and are stripped
// from the address bar as soon as they are read.

const PREFIX = 'pubtracker_';

// `get` drives the "How to get one" dropdown in the API Keys dialog: plain
// text steps (rendered with textContent) plus one sign-up link.
export const KEY_FIELDS = [
  { id: 'email',    param: 'email',    label: 'Contact email',
    help: 'Optional. Sent to OpenAlex and PubMed as the contact they ask heavy users for, so they can reach you instead of blocking you.' },
  { id: 'openalex', param: 'openalex', label: 'OpenAlex API key',
    help: 'Without one, everyone on your network shares $0.10 of OpenAlex usage a day, about 50 to 100 PIs. A free key gives you your own $1 a day, about 500 to 1,000 PIs.',
    get: {
      url: 'https://openalex.org/signup', linkText: 'openalex.org/signup',
      time: 'Free, about a minute.',
      steps: [
        'Make a free account at openalex.org/signup.',
        'Click the link in the verification email OpenAlex sends you. The key does not work until you do.',
        'Open Settings, then API key (openalex.org/settings/api-key), and copy the key.',
      ],
    } },
  { id: 's2',       param: 's2',       label: 'Semantic Scholar API key',
    help: 'Without one, requests share a public pool with every keyless user and are often slowed or refused at busy times. A key gives you a steady one request a second.',
    get: {
      url: 'https://www.semanticscholar.org/product/api#api-key-form', linkText: 'Semantic Scholar API key form',
      time: 'Free, but reviewed by hand: allow a few days to a few weeks.',
      steps: [
        'Open the API key request form on Semantic Scholar\'s API page.',
        'Fill in your name, email, institution and what you\'ll use it for, e.g. "Looking up recent publications of our institution\'s PIs for research administration reporting."',
        'Semantic Scholar emails the key once the request is approved.',
      ],
    } },
  { id: 'ncbi',     param: 'ncbi',     label: 'NCBI (PubMed) API key',
    help: 'Without one, PubMed allows 3 requests a second, which is usually enough. A key raises that to 10.',
    get: {
      url: 'https://account.ncbi.nlm.nih.gov/settings/', linkText: 'NCBI account settings',
      time: 'Free, instant.',
      steps: [
        'Sign in to NCBI. You can use Google, ORCID, Login.gov or many university logins.',
        'Open Account Settings and scroll to API Key Management.',
        'Click Create an API Key and copy it.',
      ],
    } },
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
