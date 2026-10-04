// Server-Sent Events: a minimal reader for fetch() bodies.

/**
 * Reads an SSE response body and calls `onEvent` for each message.
 * Resolves when the stream ends; rejects on network errors.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(msg: { id: string | null, event: string, data: string }) => void} onEvent
 */
export async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  let msg = { id: null, event: 'message', data: [] };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          if (msg.data.length) onEvent({ id: msg.id, event: msg.event, data: msg.data.join('\n') });
          msg = { id: null, event: 'message', data: [] };
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') msg.data.push(val);
        else if (field === 'id') msg.id = val;
        else if (field === 'event') msg.event = val;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Follows a job's event stream over HTTP, reconnecting with Last-Event-ID until the job is final.
 *
 * @param {object} opts
 * @param {string} opts.url            .../v1/jobs/:id/events
 * @param {Record<string, string> | (() => Promise<Record<string, string>> | Record<string, string>)} [opts.headers]   A function is called on every (re)connect, so tokens can be refreshed.
 * @param {(event: import('./types.js').JobEvent) => void} opts.onEvent
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.retryDelayMs]
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<import('./types.js').JobEvent>} the final event
 */
export async function followJobEvents({ url, headers = {}, onEvent, signal, maxRetries = 5, retryDelayMs = 500, fetch: f = globalThis.fetch }) {
  let lastSeq = 0;
  let finalEvent = null;
  let failures = 0;
  while (!finalEvent) {
    signal?.throwIfAborted();
    try {
      const current = typeof headers === 'function' ? await headers() : headers;
      const res = await f(url, {
        headers: { accept: 'text/event-stream', ...current, ...(lastSeq ? { 'last-event-id': String(lastSeq) } : {}) },
        signal,
      });
      if (!res.ok || !res.body) {
        const err = new Error(`event stream returned HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const seqBefore = lastSeq;
      await readSse(res.body, msg => {
        if (msg.event !== 'job') return;
        const event = JSON.parse(msg.data);
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        failures = 0;
        onEvent(event);
        if (['succeeded', 'failed', 'cancelled'].includes(event.state)) finalEvent = event;
      });
      if (!finalEvent && lastSeq === seqBefore) {
        // The stream closed without telling us anything new: count it as a failure.
        if (++failures > maxRetries) throw new Error('event stream keeps closing without events');
        await new Promise(r => setTimeout(r, retryDelayMs * failures));
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (++failures > maxRetries) throw err;
      await new Promise(r => setTimeout(r, retryDelayMs * failures));
    }
  }
  return finalEvent;
}
