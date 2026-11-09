// Polite HTTP: one rate limiter per source, retries on 429/5xx with backoff,
// and a shared AbortSignal so the Stop button cancels everything in flight.

export class Limiter {
  constructor(minIntervalMs) {
    this.minInterval = minIntervalMs;
    this.next = 0;
  }
  setInterval(ms) { this.minInterval = ms; }
  async wait(signal) {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minInterval;
    if (at > now) await sleep(at - now, signal);
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

function abortError() {
  return new DOMException('Stopped', 'AbortError');
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// GET JSON through a limiter. Retries up to `retries` times on 429 and 5xx,
// honoring Retry-After when the server sends it.
export async function getJSON(url, { limiter, signal, headers = {}, retries = 4 } = {}) {
  let attempt = 0;
  for (;;) {
    if (limiter) await limiter.wait(signal);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt >= retries) throw new HttpError(0, 'Network error (the service may be down or blocking browser requests)');
      attempt++;
      await sleep(backoff(attempt), signal);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      attempt++;
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(ra > 0 ? ra * 1000 : backoff(attempt), signal);
      continue;
    }
    if (res.status === 429) {
      throw new HttpError(429, 'Rate limit or daily budget reached. Wait and run again, or add a free API key for this source.');
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    if (res.status === 403 && /key_not_activated/.test(detail)) {
      throw new HttpError(403, 'This API key is not active yet: click the link in the verification email.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(res.status, 'The API key was refused. Check it under API Keys, or remove it to run without one.');
    }
    throw new HttpError(res.status, `HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
}
