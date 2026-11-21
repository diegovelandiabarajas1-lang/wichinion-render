// Modo Colibri: modelo local (coli serve, API compatible con OpenAI) en lugar de NVIDIA NIM. Sin clave ni pasarela.
// Colibri carga el modelo en minutos: se descubre con GET /v1/models y se reintenta hasta que responda.

/** ¿El servidor de modelos es Colibri? MOTOR_BACKEND=colibri, o MOTOR_NIM_BASE apuntando a un puerto 8000 local. */
export function isColibri(env, nimBase) {
  const b = String(env?.MOTOR_BACKEND ?? '').toLowerCase();
  if (b === 'colibri') return true;
  if (b === 'nvidia') return false;
  try {
    const u = new URL(nimBase);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.port === '8000';
  } catch { return false; }
}

/** Entrada de catálogo (misma forma que los modelos de NVIDIA) para el modelo cargado en Colibri. */
export function colibriModel(id, cfg) {
  return {
    id, modelID: id, providerID: 'colibri', type: 'chat', family: 'colibri', name: id,
    compatibility: { reasoningField: 'reasoning_content' },
    package: '@opencode/ai/providers/openai-compatible',
    capabilities: { tools: true, input: ['text'], output: ['text'], temperature: true },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: 'active', enabled: true,
    limit: { context: cfg.contextTokens, output: Math.min(cfg.contextTokens, 8192) },
    settings: { baseURL: cfg.nimBase, provider: 'colibri' },
  };
}

/** Descubre el modelo de Colibri y lo mantiene al día. `ready(signal)` espera hasta que haya uno. */
export class Colibri {
  constructor(cfg, { fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.model = null; // id del modelo cargado
    this.waiters = [];
    this.timer = null;
    this.stopped = false;
    this.lastError = '';
  }

  get isReady() { return !!this.model; }

  /** Una consulta a /v1/models. Devuelve el id del primer modelo, o null. */
  async probe() {
    try {
      const res = await this.fetch(this.cfg.nimBase + '/models', { headers: { Authorization: 'Bearer ' + this.cfg.backendKey }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) { this.lastError = 'HTTP ' + res.status; return null; }
      const j = await res.json();
      const id = (j.data ?? []).map((m) => m?.id).find((x) => typeof x === 'string' && x);
      if (!id) { this.lastError = 'Colibri aún no declara ningún modelo'; return null; }
      this.lastError = '';
      return id;
    } catch (e) {
      this.lastError = e.cause?.code ?? e.message;
      return null;
    }
  }

  /** Arranca el descubrimiento en segundo plano (reintenta cada `pollMs` hasta tener modelo). */
  start() {
    const tick = async () => {
      if (this.stopped) return;
      const id = await this.probe();
      if (id) { this.set(id); return; }
      this.timer = setTimeout(tick, this.cfg.colibriPollMs);
      this.timer.unref?.();
    };
    void tick();
  }

  set(id) {
    this.model = id;
    this.cfg.defaultModel = { id, providerID: 'colibri' };
    for (const w of this.waiters.splice(0)) w.resolve(id);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const w of this.waiters.splice(0)) w.reject(new Error('Servidor detenido'));
  }

  /** Espera a que Colibri tenga un modelo cargado (hasta `colibriWaitMs`). */
  ready(signal) {
    if (this.model) return Promise.resolve(this.model);
    return new Promise((resolve, reject) => {
      const w = { resolve: (v) => { cleanup(); resolve(v); }, reject: (e) => { cleanup(); reject(e); } };
      const t = setTimeout(() => w.reject(Object.assign(new Error(`Colibri no estuvo listo a tiempo${this.lastError ? ' (' + this.lastError + ')' : ''}. ¿Terminó de cargar el modelo?`), { status: 503 })), this.cfg.colibriWaitMs);
      const onAbort = () => w.reject(signal.reason instanceof Error ? signal.reason : new Error('Interrumpido'));
      const cleanup = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }
}
