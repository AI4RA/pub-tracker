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
  // `limit` marks a source that is out of quota for now (daily budget, or a
  // throttle longer than we will wait): the run stops asking it.
  constructor(status, message, { limit = false } = {}) {
    super(message);
    this.status = status;
    this.limit = limit;
  }
}

// The status line listens here to say what a stalled-looking run is waiting on.
export const events = new EventTarget();
function announceWait(url, ms, why) {
  events.dispatchEvent(new CustomEvent('wait', { detail: { host: new URL(url).host, ms, why } }));
}

const TIMEOUT_MS = 20000;      // one request
const MAX_WAIT_MS = 30000;     // longest throttle we sit out; longer means a quota is spent

const LIMIT_MSG = 'Rate limit or daily budget reached, so this source was skipped for the rest of the run. Wait and run again, or add a free API key for this source.';

// One fetch with a timeout, still cancellable by the Stop button.
async function fetchWithTimeout(url, headers, signal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctl.signal });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (e.name === 'AbortError') throw new TypeError('timed out');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// GET JSON through a limiter. Retries throttles (429), server errors (5xx),
// timeouts and network failures with backoff, but never sits out a wait
// longer than MAX_WAIT_MS: a long Retry-After means a spent quota, and
// waiting it out would freeze the whole run. Some services (PubMed) send
// their 429 without CORS headers, which a browser reports as a network
// error, so those are retried the same way.
export async function getJSON(url, { limiter, signal, headers = {}, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    if (limiter) await limiter.wait(signal);
    let res;
    try {
      res = await fetchWithTimeout(url, headers, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt >= retries) {
        throw new HttpError(0, (/timed out/.test(e.message)
          ? 'No answer within 20 seconds, after retries'
          : 'Could not connect, after retries (the service may be down or throttling)')
          + ', so this source was skipped for the rest of the run. Try again later.', { limit: true });
      }
      attempt++;
      const ms = backoff(attempt);
      announceWait(url, ms, /timed out/.test(e.message) ? 'timed out, retrying' : 'connection failed, retrying');
      await sleep(ms, signal);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('Retry-After'));
      const ms = ra > 0 ? ra * 1000 : backoff(attempt + 1);
      if (res.status === 429 && (ms > MAX_WAIT_MS || attempt >= retries)) {
        throw new HttpError(429, LIMIT_MSG, { limit: true });
      }
      if (attempt < retries) {
        attempt++;
        announceWait(url, ms, res.status === 429 ? 'rate limit' : `server error ${res.status}`);
        await sleep(Math.min(ms, MAX_WAIT_MS), signal);
        continue;
      }
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    if (res.status === 403 && /key_not_activated/.test(detail)) {
      throw new HttpError(403, 'This API key is not active yet: click the link in the verification email.', { limit: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(res.status, 'The API key was refused. Check it under API Keys, or remove it to run without one.', { limit: true });
    }
    throw new HttpError(res.status, `HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
}

function backoff(attempt) {
  return Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
}
