// Wichinion: servidor HTTP compatible con el subconjunto de la API de OpenCode 2.x
// que usan los clientes de Wichi (APK, Wichi para PC, extensión de VS Code).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, Credentials, modelCatalog, providers, VERSION, OPENCODE_API } from './config.js';
import { Store, paginate, CursorError } from './store.js';
import { Bus } from './events.js';
import { Runner } from './run.js';
import { newMessageId } from './ids.js';
import { Permissions, DEFAULT_RULES } from './perm.js';
import { Mcp } from './mcp.js';
import { Colibri } from './colibri.js';
import { Vault, verifyPassword } from './vault.js';
import { Audit } from './audit.js';
import { posture } from './postura.js';
import { createHash } from 'node:crypto';
import { loadCommands, loadSkills, publicCommand, publicSkill, renderTemplate } from './instructions.js';
import { resolveSafe, SafetyError, redact } from './safety.js';
import { addRoutes } from './routes2.js';

class HttpError extends Error {
  constructor(status, body) {
    super(body?.message ?? String(status));
    this.status = status;
    this.body = body;
  }
}
const sessionNotFound = (id) => new HttpError(404, { _tag: 'SessionNotFoundError', sessionID: id, message: `Session not found: ${id}` });
const badRequest = (message, tag = 'BadRequestError') => new HttpError(400, { _tag: tag, message });

function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createMotor(cfg) {
  fs.mkdirSync(cfg.workdir, { recursive: true });
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const vault = new Vault(cfg.dataDir, cfg.secret);
  const store = new Store(cfg.dataDir, vault, cfg.env?.MOTOR_ENCRYPT_SESSIONS === '1');
  const creds = new Credentials(cfg.dataDir, cfg.env, vault);
  const audit = new Audit({ file: cfg.env?.MOTOR_AUDIT === '0' ? null : path.join(cfg.dataDir, 'audit.log'), secret: cfg.secret, redact: (t) => redact(t, [creds.key('nvidia'), cfg.password, cfg.secret]), stdout: cfg.env?.MOTOR_AUDIT_STDOUT === '1' });
  const bus = new Bus({ max: Number(cfg.env?.MOTOR_MAX_SSE) || 200 });
  const emit = bus.emit;
  const perms = new Permissions({
    bus,
    audit,
    dir: cfg.dataDir,
    projectID: cfg.projectID,
    timeoutMs: Number(cfg.env?.MOTOR_PERMISSION_TIMEOUT_MS) || undefined,
    base: cfg.env?.MOTOR_PERMISSIONS === 'allow-all' ? [{ action: '*', resource: '*', effect: 'allow' }] : DEFAULT_RULES,
  });
  const mcp = new Mcp({ dir: cfg.dataDir, workdir: cfg.workdir, vault });
  const colibri = cfg.backend === 'colibri' ? new Colibri(cfg) : null;
  const runner = new Runner({ cfg, store, creds, perms, mcp, bus, audit, colibri });
  const failures = new Map(); // ip -> {n, until}
  const started = Date.now();
  let server;

  const dirOf = (q) => q.get('location[directory]') || cfg.workdir;
  const locOf = (q) => ({ location: { directory: dirOf(q) } });
  const models = () => modelCatalog(cfg);
  /** Carpeta real sobre la que operan los archivos: la pedida si cae dentro del directorio de trabajo, si no éste. */
  const fsRoot = (q) => {
    const d = q.get('location[directory]');
    try { return d && path.isAbsolute(d) ? resolveSafe({ root: cfg.workdir, protectedDirs: [cfg.dataDir] }, d, { allowSecrets: true }) : cfg.workdir; } catch { return cfg.workdir; }
  };
  const safePath = (q, p) => {
    const root = fsRoot(q);
    try {
      // Una ruta absoluta que no cuelga del directorio de trabajo se toma relativa a él (como /workspace en el contenedor).
      const clean = p.replace(/^[/\\]+/, '');
      let abs;
      try { abs = resolveSafe({ root: cfg.workdir, cwd: root, protectedDirs: [cfg.dataDir] }, p); } catch { abs = resolveSafe({ root: cfg.workdir, cwd: root, protectedDirs: [cfg.dataDir] }, clean); }
      return { root, abs };
    } catch (e) {
      if (e instanceof SafetyError) throw badRequest(e.message, 'PathNotAllowedError');
      throw e;
    }
  };

  const sessionPublic = (s) => s;
  const SES_RE = /^ses_[A-Za-z0-9]{8,64}$/;
  const getSession = (id) => {
    const e = SES_RE.test(id) ? store.get(id) : undefined;
    if (!e) throw sessionNotFound(id);
    return e;
  };

  // ─────────── Rutas ───────────
  /** @type {Array<[string,RegExp,(c:any)=>any]>} */
  const routes = [];
  const route = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), '([^/]+)')).replace(/\*$/, '(.*)') + '/?$');
    routes.push([method, re, (c, m) => { keys.forEach((k, i) => (c.params[k] = decodeURIComponent(m[i + 1]))); if (pattern.endsWith('*')) c.rest = m[keys.length + 1]; return fn(c); }]);
  };

  route('GET', '/api/info', () => ({
    version: OPENCODE_API,
    engine: 'wichinion',
    engineVersion: VERSION,
    pid: process.pid,
    hostname: os.hostname(),
    urls: [`http://127.0.0.1:${cfg.port}`],
    paths: { tmp: path.join(os.tmpdir(), 'wichi-motor') },
    capabilities: { persistentPty: false },
  }));

  // ── Sesiones ──
  route('GET', '/api/session', ({ q }) => {
    const limit = Number(q.get('limit')) || 50;
    const opts = { search: q.get('search') || undefined, directory: q.get('directory') || undefined, archived: q.get('archived') || undefined };
    const r = paginate((ord) => store.list({ ...opts, order: ord }), { limit, order: q.get('order'), cursor: q.get('cursor') }, (s) => s.id, 'anchor', (s) => s.time.updated);
    return { data: r.page.map(sessionPublic), ...(r.cursor ? { cursor: r.cursor } : {}) };
  });

  route('POST', '/api/session', ({ body }) => {
    body ??= {};
    const model = body.model ? { id: body.model.id, providerID: body.model.providerID, variant: body.model.variant ?? 'default' } : { ...cfg.defaultModel, variant: 'default' };
    const directory = body.location?.directory || cfg.workdir;
    if (body.id && (!SES_RE.test(body.id) || store.has(body.id))) throw badRequest('Identificador de sesión inválido o repetido');
    if (body.permissions && !Array.isArray(body.permissions)) throw badRequest('«permissions» debe ser una lista');
    const s = store.create({ id: body.id || undefined, parentID: body.parentID || undefined, agent: body.agent || undefined, model, directory, metadata: body.metadata || undefined, projectID: cfg.projectID });
    if (Array.isArray(body.permissions)) { s.permissions = body.permissions.filter((r) => r && typeof r.action === 'string' && typeof r.resource === 'string' && ['allow', 'deny', 'ask'].includes(r.effect)); store.save(s.id); }
    emit('session.created', { sessionID: s.id, slug: s.id.slice(-8).toLowerCase(), version: OPENCODE_API, projectID: s.projectID, location: s.location, subpath: '', model: { id: model.id, providerID: model.providerID } }, { location: s.location });
    return { data: sessionPublic(s) };
  });

  route('GET', '/api/session/active', () => ({ data: Object.fromEntries(runner.activeIds().map((id) => [id, { type: 'running' }])) }));
  route('GET', '/api/session/{id}', ({ params }) => ({ data: sessionPublic(getSession(params.id).session) }));
  route('DELETE', '/api/session/{id}', ({ params }) => {
    getSession(params.id);
    runner.interrupt(params.id);
    perms.rejectSession(params.id, 'Conversación borrada');
    runner.forget(params.id);
    store.delete(params.id);
    emit('session.deleted', { sessionID: params.id }, {});
    return 204;
  });
  route('PATCH', '/api/session/{id}', ({ params, body }) => {
    const { session: s } = getSession(params.id);
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) throw badRequest('Se esperaba un objeto JSON');
    if (typeof body?.title === 'string') {
      s.title = body.title;
      emit('session.renamed', { sessionID: s.id, title: s.title }, { location: s.location });
    }
    if (body && 'archived' in body) {
      if (body.archived) s.time.archived = Date.now();
      else delete s.time.archived;
    }
    s.time.updated = Date.now();
    store.save(s.id);
    return 204;
  });

  route('GET', '/api/session/{id}/message', ({ params, q }) => {
    const e = getSession(params.id);
    const limit = Number(q.get('limit')) || 50;
    const r = paginate((ord) => (ord === 'asc' ? [...e.messages] : [...e.messages].reverse()), { limit, order: q.get('order'), cursor: q.get('cursor') }, (m) => m.id, 'flat');
    return { data: r.page, ...(r.cursor ? { cursor: r.cursor } : {}) };
  });
  route('GET', '/api/session/{id}/message/{mid}', ({ params }) => {
    const m = getSession(params.id).messages.find((x) => x.id === params.mid);
    if (!m) throw new HttpError(404, { _tag: 'MessageNotFoundError', message: `Message not found: ${params.mid}` });
    return { data: m };
  });

  route('POST', '/api/session/{id}/prompt', ({ params, body }) => {
    const { session: s } = getSession(params.id);
    if (!body || typeof body.text !== 'string') throw badRequest('Falta «text»');
    if (!runner.isBusy(s.id) && runner.activeIds().length >= (Number(cfg.env?.MOTOR_MAX_RUNS) || 8)) throw new HttpError(429, { _tag: 'TooManyRunsError', message: 'Demasiadas ejecuciones simultáneas' });
    return { data: runner.prompt(s, body) };
  });
  route('POST', '/api/session/{id}/model', ({ params, body }) => {
    const { session: s } = getSession(params.id);
    const m = body?.model;
    if (!m?.id || !m?.providerID) throw badRequest('Falta «model»');
    const previous = s.model;
    s.model = { id: m.id, providerID: m.providerID, variant: m.variant ?? 'default' };
    if (previous && (previous.id !== s.model.id || previous.providerID !== s.model.providerID) && store.get(s.id).messages.some((x) => x.type === 'user')) {
      // OpenCode deja constancia del cambio de modelo en la conversación
      store.get(s.id).messages.push({ id: newMessageId(), time: { created: Date.now() }, type: 'model-switched', model: { id: m.id, providerID: m.providerID }, previous });
    }
    s.time.updated = Date.now();
    store.save(s.id);
    return 204;
  });
  route('POST', '/api/session/{id}/interrupt', ({ params }) => {
    getSession(params.id);
    return { interrupted: runner.interrupt(params.id) };
  });

  // ── Modelos, proveedores e integración ──
  route('GET', '/api/model', ({ q }) => ({ ...locOf(q), data: models() }));
  route('GET', '/api/model/default', ({ q }) => {
    const m = models().find((x) => x.id === cfg.defaultModel.id) ?? models()[0];
    if (!m) throw new HttpError(503, { _tag: 'ModelLoadingError', message: 'Colibri aún está cargando el modelo' + (colibri?.lastError ? ' (' + colibri.lastError + ')' : '') });
    return { ...locOf(q), data: m };
  });
  route('GET', '/api/provider', ({ q }) => ({ ...locOf(q), data: providers(cfg, creds) }));
  route('GET', '/api/provider/{id}', ({ params, q }) => {
    const p = providers(cfg, creds).find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, { _tag: 'ProviderNotFoundError', message: `Provider not found: ${params.id}` });
    return { ...locOf(q), data: p };
  });
  const integration = () => (cfg.backend === 'colibri' ? { id: 'colibri', name: 'Colibri (local)', methods: [], connections: [] } : { id: 'nvidia', name: 'Nvidia', methods: [{ type: 'key' }, { type: 'env', names: ['NVIDIA_API_KEY'] }], connections: creds.connections('nvidia') });
  route('GET', '/api/integration', ({ q }) => ({ ...locOf(q), data: [integration()] }));
  route('GET', '/api/integration/{id}', ({ params, q }) => {
    if (params.id !== integration().id) throw new HttpError(404, { _tag: 'IntegrationNotFoundError', message: `Integration not found: ${params.id}` });
    return { ...locOf(q), data: integration() };
  });
  route('POST', '/api/integration/{id}/connect/key', ({ params, body }) => {
    if (params.id !== 'nvidia') throw new HttpError(404, { _tag: 'IntegrationNotFoundError', message: `Integration not found: ${params.id}` });
    if (!body?.key || typeof body.key !== 'string') throw badRequest('Falta «key»');
    try { creds.addKey('nvidia', body.key.trim(), body.label || undefined); } catch (e) { throw new HttpError(409, { _tag: 'VaultLockedError', message: e.message }); }
    return 204;
  });

  addRoutes({ audit, getPosture: () => posture(cfg, { creds, vault, audit, mcp }), emit, route, cfg, store, perms, mcp, runner, getSession, SES_RE, locOf, HttpError, badRequest });

  // ── Archivos (básicos, confinados a la carpeta de trabajo) ──
  route('GET', '/api/fs/list', ({ q }) => {
    const { root, abs } = safePath(q, q.get('path') || '.');
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { throw new HttpError(404, { _tag: 'FileNotFoundError', message: 'Carpeta no encontrada' }); }
    const data = ents.map((d) => ({ path: path.relative(root, path.join(abs, d.name)).split(path.sep).join('/') + (d.isDirectory() ? '/' : ''), type: d.isDirectory() ? 'directory' : 'file' }));
    return { location: { directory: root }, data };
  });
  route('GET', '/api/fs/read/*', ({ q, rest, res }) => {
    const { abs } = safePath(q, decodeURIComponent(rest));
    let buf;
    try { buf = fs.readFileSync(abs); } catch { throw new HttpError(404, { _tag: 'FileNotFoundError', message: 'Archivo no encontrado' }); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
    return 'sent';
  });
  route('POST', '/api/experimental/fs/write', ({ q, raw }) => {
    const p = q.get('path');
    if (!p) throw badRequest('Falta «path»');
    const { root, abs } = safePath(q, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, raw);
    return { location: { directory: root }, data: { path: path.relative(root, abs).split(path.sep).join('/') } };
  });

  // ─────────── HTTP ───────────
  async function readBody(req, limit = 64 * 1024 * 1024) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > limit) throw new HttpError(413, { message: 'Cuerpo demasiado grande' });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  const sendJson = (res, status, obj) => {
    const t = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(t) });
    res.end(t);
  };

  const okCache = new Map(); // sha256(cabecera) → vence (scrypt es lento a propósito: se recuerda un acierto 5 min)
  function authorized(req) {
    if (!cfg.password && !cfg.passwordHash) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (!sameSecret(u, cfg.user)) return false;
    if (!cfg.passwordHash) return sameSecret(rest.join(':'), cfg.password);
    const k = createHash('sha256').update(h).digest('hex');
    const hit = okCache.get(k);
    if (hit && hit > Date.now()) return true;
    const ok = verifyPassword(rest.join(':'), cfg.passwordHash);
    if (ok) { if (okCache.size > 100) okCache.clear(); okCache.set(k, Date.now() + 5 * 60 * 1000); }
    return ok;
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const origin = req.headers.origin;
      const allowed = (cfg.env?.MOTOR_CORS || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (origin && allowed.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        const ok = origin && allowed.includes(origin);
        res.writeHead(204, ok ? { 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE' } : {});
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
      const ip = (cfg.env?.MOTOR_TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
      const f = failures.get(ip);
      if (f && f.until > Date.now()) { res.setHeader('Retry-After', String(Math.ceil((f.until - Date.now()) / 1000))); return sendJson(res, 429, { _tag: 'TooManyAttemptsError', message: 'Demasiados intentos fallidos' }); }
      if (!authorized(req)) {
        const n = (f && f.until <= Date.now() && f.until !== 0 ? 0 : f?.n ?? 0) + 1;
        if (n === 1 || n === 10) audit.log(n >= 10 ? 'auth.lockout' : 'auth.failed', { ip, path: url.pathname });
        failures.set(ip, { n, until: n >= (Number(cfg.env?.MOTOR_MAX_AUTH_FAILS) || 10) ? Date.now() + (Number(cfg.env?.MOTOR_LOCKOUT_MS) || 60000) : 0 });
        if (failures.size > 5000) failures.clear();
        return sendJson(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
      }
      failures.delete(ip);
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/event') return bus.sse(req, res);
      let hit;
      for (const [m, re, fn] of routes) {
        if (m !== req.method) continue;
        const mm = re.exec(pathname);
        if (mm) { hit = [fn, mm]; break; }
      }
      if (!hit) {
        res.writeHead(404);
        return res.end();
      }
      const raw = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, url.pathname === '/api/experimental/fs/write' ? 64 * 1024 * 1024 : 16 * 1024 * 1024);
      let body;
      const ct = req.headers['content-type'] || '';
      if (raw.length && ct.includes('json')) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw badRequest('JSON inválido'); }
      }
      const ctx = { req, res, q: url.searchParams, params: {}, body, raw };
      const out = await hit[0](ctx, hit[1]);
      if (req.method !== 'GET') audit.log('http.mutation', { method: req.method, path: url.pathname.replace(/\/(ses|msg|per)_[A-Za-z0-9]+/g, '/$1_…'), status: out === 204 ? 204 : 200, ip });
      if (out === 'sent') return;
      if (out === 204) { res.writeHead(204); return res.end(); }
      sendJson(res, 200, out);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return e.body ? sendJson(res, e.status, e.body) : (res.writeHead(e.status), res.end());
      if (e instanceof CursorError) return sendJson(res, 400, { _tag: 'InvalidCursorError', message: e.message });
      if (['EISDIR', 'ENOTDIR', 'ENOENT', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'EINVAL', 'EEXIST', 'EBUSY', 'ELOOP', 'EMFILE'].includes(e?.code)) return sendJson(res, 400, { _tag: 'FileSystemError', message: 'No se pudo completar la operación de archivos (' + e.code + ')' });
      if (e?.code === 'ECONNRESET' || e?.message === 'aborted') return res.destroy();
      console.error('[motor]', e?.message);
      sendJson(res, 500, { _tag: 'InternalError', message: 'Error interno' });
    }
  }

  return {
    cfg, store, creds, runner, perms, mcp, audit, vault, colibri, posture: () => posture(cfg, { creds, vault, audit, mcp }),
    listen() {
      server = http.createServer(handler);
      server.requestTimeout = 120000; // recibir la petición entera (no afecta a las respuestas SSE)
      server.headersTimeout = 30000;
      server.maxHeadersCount = 100;
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => { resolve(server.address().port); const conectados = cfg.env?.MOTOR_MCP_AUTOCONNECT !== '0' ? mcp.connectAll() : Promise.resolve(); colibri?.start(); if (colibri) void colibri.ready().then(() => conectados).then(() => runner.warm()).catch(() => {}); });
      });
    },
    async close() {
      colibri?.stop();
      await runner.shutdown();
      await mcp.shutdown();
      store.flush();
      bus.closeAll();
      await new Promise((r) => server.close(r));
    },
    uptime: () => Date.now() - started,
    newMessageId,
  };
}

// ¿Se ejecutó directamente (node src/server.js)?
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const motor = createMotor(cfg);
  const port = await motor.listen();
  console.log(`Wichinion ${VERSION} (API compatible con OpenCode ${OPENCODE_API}) escuchando en el puerto ${port}`);
  console.log(`  datos: ${cfg.dataDir}\n  carpeta de trabajo: ${cfg.workdir}\n  modelos vía: ${cfg.nimBase}${cfg.backend === 'colibri' ? ' (Colibri, local; sin clave)' : ''}`);
  for (const p of motor.posture()) if (p.level !== 'ok') console.log(`  [${p.level.toUpperCase()}] ${p.msg}`);
  if (cfg.backend === 'colibri') console.log('  modelo: se descubre con GET /models cuando Colibri termine de cargar');
  else console.log(`  clave de NVIDIA: ${motor.creds.has('nvidia') ? 'disponible' : 'falta (POST /api/integration/nvidia/connect/key o NVIDIA_API_KEY)'}`);
  const stop = async () => { await motor.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
