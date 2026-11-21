// Permisos: reglas (allow/deny/ask), peticiones pendientes (`permission.asked`) y «siempre» guardado.
import fs from 'node:fs';
import path from 'node:path';
import { newPermissionId } from './ids.js';

export class PermissionRejected extends Error {
  constructor(message) { super(message || 'El usuario rechazó el permiso'); this.name = 'PermissionRejected'; }
}

const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
const matches = (pattern, value) => pattern === '*' || globRe(pattern).test(value);

/** Reglas por defecto: leer dentro de la carpeta de trabajo sí; escribir, ejecutar y salir a internet, preguntar. */
export const DEFAULT_RULES = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'skill', resource: '*', effect: 'allow' },
  { action: 'mcp_activar', resource: '*', effect: 'allow' },
];

export class Permissions {
  constructor({ dir, projectID, timeoutMs = 10 * 60 * 1000, base = DEFAULT_RULES, bus, audit }) {
    this.bus = bus;
    this.audit = audit;
    this.file = path.join(dir, 'permissions.json');
    this.projectID = projectID;
    this.timeoutMs = timeoutMs;
    this.base = base;
    this.pending = new Map();
    try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.saved = []; }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  listSaved() { return this.saved.map((s) => ({ id: s.id, projectID: this.projectID, action: s.action, resource: s.resource, time: s.time })); }
  patchSaved(id, { action, resource }) {
    const s = this.saved.find((x) => x.id === id);
    if (!s) return false;
    if (action) s.action = action;
    if (resource) s.resource = resource;
    s.time.updated = Date.now();
    this.persist();
    return true;
  }
  deleteSaved(id) {
    const i = this.saved.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.saved.splice(i, 1);
    this.persist();
    return true;
  }

  /** Efecto de una acción sobre un recurso: gana la última regla que coincide (base < guardadas < sesión). */
  /**
   * `strict`: la acción no se puede analizar o viene de contenido no confiable → un «allow» solo vale si es EXACTO
   * (sin comodines en acción ni recurso). Los «deny» siempre valen. Así «allow-all» o «ls *» nunca aprueban a ciegas.
   */
  evaluate(session, action, resource, strict = false) {
    const rules = [...this.base, ...this.saved.map((s) => ({ action: s.action, resource: s.resource, effect: 'allow' })), ...(session.permissions ?? [])];
    let effect = 'ask';
    for (const r of rules) {
      if (!matches(r.action, action) || !matches(r.resource, resource)) continue;
      if (strict && r.effect === 'allow' && /[*?]/.test(r.action + r.resource)) continue;
      effect = r.effect;
    }
    return effect;
  }

  /**
   * Pide permiso para `action` sobre `resources`. Resuelve si se permite; lanza PermissionRejected si se deniega.
   * `save`: patrones que se guardan si el usuario responde «always».
   */
  async check({ session, action, resources, save, metadata, source, message, signal, strict = false }) {
    const effects = resources.map((r) => this.evaluate(session, action, r, strict));
    if (effects.includes('deny')) {
      this.audit?.log('permission.denied', { sessionID: session.id, action, resources });
      throw new PermissionRejected(`Acción denegada por las reglas: ${action} ${resources.join(', ')}`);
    }
    if (effects.every((e) => e === 'allow')) {
      this.audit?.log('permission.allowed', { sessionID: session.id, action, resources, strict });
      return 'allow';
    }
    const id = newPermissionId();
    const req = { id, sessionID: session.id, action, resources, save: strict && save === undefined ? [] : save ?? resources, ...(metadata || strict ? { metadata: { ...(metadata ?? {}), ...(strict ? { strict: true } : {}) } } : {}), ...(source ? { source } : {}), ...(message ? { message } : {}) };
    return new Promise((resolve, reject) => {
      const done = (decision, why) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        if (decision === 'reject') reject(new PermissionRejected(why));
        else resolve(decision);
      };
      const timer = setTimeout(() => { this.emitReplied(req, 'reject'); done('reject', 'Se agotó el tiempo para responder el permiso'); }, this.timeoutMs);
      timer.unref?.();
      const onAbort = () => { this.emitReplied(req, 'reject'); done('reject', 'Interrumpido'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { req, done });
      this.audit?.log('permission.asked', { sessionID: session.id, id, action, resources, strict });
      this.bus.emit('permission.asked', req, { location: { directory: session.location?.directory } });
    });
  }

  emitReplied(req, reply) {
    this.audit?.log('permission.replied', { sessionID: req.sessionID, id: req.id, action: req.action, reply });
    this.bus.emit('permission.replied', { sessionID: req.sessionID, requestID: req.id, reply }, {});
  }

  list(sessionID) {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !sessionID || r.sessionID === sessionID);
  }

  get(sessionID, id) {
    const p = this.pending.get(id);
    return p && p.req.sessionID === sessionID ? p.req : undefined;
  }

  /** Responde una petición. Devuelve false si no existe. */
  reply(sessionID, id, decision, message) {
    const p = this.pending.get(id);
    if (!p || p.req.sessionID !== sessionID) return false;
    if (decision === 'always') {
      for (const pat of p.req.save ?? p.req.resources) {
        if (!this.saved.some((s) => s.action === p.req.action && s.resource === pat)) {
          this.saved.push({ id: 'psv_' + newPermissionId().slice(4), action: p.req.action, resource: pat, time: { created: Date.now(), updated: Date.now() } });
        }
      }
      this.persist();
    }
    this.emitReplied(p.req, decision);
    p.done(decision, message);
    return true;
  }

  rejectSession(sessionID, why) {
    for (const p of [...this.pending.values()]) if (p.req.sessionID === sessionID) { this.emitReplied(p.req, 'reject'); p.done('reject', why); }
  }
}
