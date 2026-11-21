// Sesiones y mensajes guardados en disco (un JSON por sesión, escritura atómica).
import fs from 'node:fs';
import path from 'node:path';
import { newSessionId } from './ids.js';

export const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export class Store {
  constructor(dir, vault = null, encrypt = false) {
    this.vault = vault;
    this.encrypt = !!(encrypt && vault?.active);
    this.dir = path.join(dir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    /** @type {Map<string,{session:any,messages:any[]}>} */
    this.map = new Map();
    this.timers = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        let raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
        if (raw.startsWith('wvault1:')) raw = vault.open(raw.trim(), f);
        const o = JSON.parse(raw);
        if (o?.session?.id) this.map.set(o.session.id, { session: o.session, messages: o.messages ?? [] });
      } catch { /* archivo dañado: se ignora */ }
    }
    // Lo que quedó «ocupado» al apagarse ya no está corriendo.
    for (const e of this.map.values()) {
      const t = e.session.time ?? {};
      if (t.busy && !(t.idle >= t.busy)) {
        t.idle = Date.now();
        e.session.outcome = 'interrupted';
      }
    }
  }

  file(id) {
    if (!/^ses_[A-Za-z0-9]{8,64}$/.test(id)) throw new Error('Identificador de sesión inválido');
    return path.join(this.dir, id + '.json');
  }

  create({ id, parentID, agent, model, directory, metadata, projectID }) {
    const now = Date.now();
    const session = {
      id: id ?? newSessionId(),
      projectID,
      ...(parentID ? { parentID } : {}),
      ...(agent ? { agent } : {}),
      model,
      cost: 0,
      tokens: emptyTokens(),
      time: { created: now, updated: now },
      location: { directory },
      ...(metadata ? { metadata } : {}),
    };
    this.map.set(session.id, { session, messages: [] });
    this.save(session.id, true);
    return session;
  }

  get(id) { return this.map.get(id); }
  has(id) { return this.map.has(id); }

  save(id, now = false) {
    clearTimeout(this.timers.get(id));
    const run = () => {
      this.timers.delete(id);
      const e = this.map.get(id);
      if (!e) return;
      const tmp = this.file(id) + '.tmp';
      const body = JSON.stringify(e);
      fs.writeFileSync(tmp, this.encrypt ? this.vault.seal(body, path.basename(this.file(id))) : body, { mode: 0o600 });
      fs.renameSync(tmp, this.file(id));
    };
    if (now) run();
    else this.timers.set(id, setTimeout(run, 150));
  }

  flush() { for (const id of [...this.timers.keys()]) this.save(id, true); }

  delete(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.map.delete(id);
    fs.rmSync(this.file(id), { force: true });
  }

  /** Lista ordenada (desc = más reciente primero). */
  list({ order = 'desc', search, directory, archived } = {}) {
    let a = [...this.map.values()].map((e) => e.session);
    if (search) a = a.filter((s) => (s.title ?? '').toLowerCase().includes(String(search).toLowerCase()));
    if (directory) a = a.filter((s) => s.location?.directory === directory);
    a = archived === 'true' ? a.filter((s) => s.time?.archived) : a.filter((s) => !s.time?.archived);
    a.sort((x, y) => (y.time.updated - x.time.updated) || (x.id < y.id ? -1 : 1));
    return order === 'asc' ? a.reverse() : a;
  }
}

// ── Paginación por cursor (base64url de un JSON, como OpenCode) ──
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

export class CursorError extends Error {}

/**
 * Pagina una lista. `getSorted(order)` devuelve todos los elementos en ese orden;
 * `keyOf(item)` da un id único. El cursor lleva el orden: no se puede combinar con
 * `order` (OpenCode responde 400 InvalidCursorError). `shape`: 'flat' (mensajes)
 * o 'anchor' (sesiones, con la hora del ancla).
 */
export function paginate(getSorted, { limit, order, cursor }, keyOf, shape = 'flat', timeOf = () => 0) {
  const n = Math.max(1, Number(limit) || 50);
  let ord = order === 'asc' ? 'asc' : 'desc';
  let dir = 'next';
  let id;
  if (cursor) {
    if (order) throw new CursorError('Cursor cannot be combined with order');
    const c = dec(cursor);
    id = c?.anchor?.id ?? c?.id;
    dir = c?.anchor?.direction ?? c?.direction;
    if (!c || !c.order || !id || (dir !== 'next' && dir !== 'previous')) throw new CursorError('Invalid cursor');
    ord = c.order;
  }
  const sorted = getSorted(ord);
  let page;
  if (!cursor) page = sorted.slice(0, n);
  else {
    const idx = sorted.findIndex((x) => keyOf(x) === id);
    if (idx < 0) throw new CursorError('Invalid cursor');
    page = dir === 'next' ? sorted.slice(idx + 1, idx + 1 + n) : sorted.slice(Math.max(0, idx - n), idx);
  }
  const out = { page };
  if (page.length) {
    const mk = (item, direction) =>
      enc(shape === 'anchor' ? { order: ord, anchor: { id: keyOf(item), time: timeOf(item), direction } } : { id: keyOf(item), order: ord, direction });
    out.cursor = { previous: mk(page[0], 'previous'), next: mk(page[page.length - 1], 'next') };
  }
  return out;
}
