// Cliente de modelos: API compatible con OpenAI (NVIDIA NIM o la pasarela local), con streaming.

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Pide una respuesta en streaming. Entrega objetos:
 *  {t:'reasoning', delta} {t:'text', delta} {t:'tool', index, id, name, args}
 *  {t:'usage', usage} {t:'finish', reason}
 */
export async function* streamChat({ baseURL, key, model, messages, tools, signal, extraBody, firstByteMs = 120000, idleMs = 120000 }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, ...(extraBody ?? {}) };
  if (tools?.length) body.tools = tools;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) signal.aborted ? ctl.abort(signal.reason) : signal.addEventListener('abort', onAbort, { once: true });
  let timer = setTimeout(() => ctl.abort(new LlmError('El modelo no respondió a tiempo', 504)), firstByteMs);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new LlmError('El modelo dejó de responder', 504)), idleMs);
  };
  const why = (e) => (ctl.signal.reason instanceof Error ? ctl.signal.reason : e);
  try {
    let res;
    try {
      res = await fetch(baseURL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) throw why(e);
      throw new LlmError('No se pudo contactar al modelo: ' + (e.cause?.code ?? e.message), 502);
    }
    if (!res.ok) {
      let msg = '';
      try {
        const t = await res.text();
        try {
          const j = JSON.parse(t);
          msg = j.error?.message ?? j.detail ?? j.message ?? t;
        } catch {
          msg = t;
        }
      } catch { /* nada */ }
      throw new LlmError(`El modelo respondió HTTP ${res.status}${msg ? ': ' + String(msg).slice(0, 300) : ''}`, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const calls = new Map();
    let finish;
    let thinkOpen = false; // <think>…</think> dentro del texto (algunos modelos)
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (ctl.signal.aborted) throw why(e);
        throw new LlmError('Se cortó la conexión con el modelo', 502);
      }
      if (chunk.done) break;
      kick();
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let j;
        try { j = JSON.parse(p); } catch { continue; }
        if (j.error) throw new LlmError(String(j.error.message ?? 'Error del modelo'), j.error.code ?? 502);
        if (j.usage) yield { t: 'usage', usage: j.usage };
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta ?? {};
        const r = d.reasoning_content ?? d.reasoning;
        if (r) yield { t: 'reasoning', delta: r };
        let c = d.content;
        while (c) {
          if (thinkOpen) {
            const k = c.indexOf('</think>');
            if (k < 0) { yield { t: 'reasoning', delta: c }; c = ''; }
            else { if (k) yield { t: 'reasoning', delta: c.slice(0, k) }; thinkOpen = false; c = c.slice(k + 8); }
          } else {
            const k = c.indexOf('<think>');
            if (k < 0) { yield { t: 'text', delta: c }; c = ''; }
            else { if (k) yield { t: 'text', delta: c.slice(0, k) }; thinkOpen = true; c = c.slice(k + 7); }
          }
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let cur = calls.get(idx);
          if (!cur) { cur = { id: tc.id, name: '', args: '' }; calls.set(idx, cur); }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) yield { t: 'tool', index, ...c };
    yield { t: 'finish', reason: finish ?? 'stop' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Respuesta completa sin streaming (se usa para el título). */
export async function completeOnce({ baseURL, key, model, messages, maxTokens = 60, signal, tools, timeoutMs = 30000 }) {
  const res = await fetch(baseURL.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false, ...(tools?.length ? { tools } : {}) }),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new LlmError('HTTP ' + res.status, res.status);
  const j = await res.json();
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage };
}
