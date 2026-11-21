// Cliente MCP: servidores remotos (HTTP «streamable») y locales (stdio, JSON-RPC por líneas).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanEnv } from './safety.js';

const PROTOCOL = '2025-03-26';

class RpcBase {
  constructor() { this.nextId = 1; }
  async init() {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'wichinion', version: '0.3.0' } }, 20000);
    await this.notify('notifications/initialized', {});
    return r;
  }
}

class HttpRpc extends RpcBase {
  constructor(cfg) { super(); this.url = cfg.url; this.headers = cfg.headers ?? {}; this.sid = null; }
  async post(msg, timeout, wantReply) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.sid ? { 'Mcp-Session-Id': this.sid } : {}), ...this.headers },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeout),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!wantReply) { await res.arrayBuffer().catch(() => {}); return null; }
    const ct = res.headers.get('content-type') || '';
    const txt = await res.text();
    if (ct.includes('text/event-stream')) {
      for (const blk of txt.split(/\n\n+/)) {
        const data = blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try { const j = JSON.parse(data); if (j.id === msg.id) return j; } catch { /* siguiente */ }
      }
      throw new Error('Respuesta MCP vacía');
    }
    return JSON.parse(txt);
  }
  async request(method, params, timeout = 60000) {
    const id = this.nextId++;
    const j = await this.post({ jsonrpc: '2.0', id, method, params }, timeout, true);
    if (j.error) throw new Error(j.error.message || 'Error MCP');
    return j.result;
  }
  async notify(method, params) { await this.post({ jsonrpc: '2.0', method, params }, 10000, false).catch(() => {}); }
  close() { if (this.sid) fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sid, ...this.headers } }).catch(() => {}); }
}

class StdioRpc extends RpcBase {
  constructor(cfg, cwd) {
    super();
    const [cmd, ...args] = cfg.command;
    this.pending = new Map();
    this.buf = '';
    this.child = spawn(cmd, args, { cwd, env: { ...cleanEnv(), ...(cfg.environment ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.dead = null;
    this.child.on('error', (e) => this.fail(e));
    this.child.on('close', () => this.fail(new Error('El servidor MCP se cerró')));
    this.child.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          const p = this.pending.get(j.id);
          if (p) { this.pending.delete(j.id); clearTimeout(p.t); j.error ? p.rej(new Error(j.error.message || 'Error MCP')) : p.res(j.result); }
        } catch { /* ruido en stdout */ }
      }
    });
  }
  fail(e) { this.dead = e; for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(e); } this.pending.clear(); }
  request(method, params, timeout = 60000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('MCP: tiempo agotado')); }, timeout);
      this.pending.set(id, { res, rej, t });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async notify(method, params) { if (!this.dead) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  close() { try { this.child.kill(); } catch { /* ya */ } }
}

export class Mcp {
  constructor({ dir, workdir, vault }) {
    this.vault = vault;
    this.locked = false;
    this.file = path.join(dir, 'mcp.json');
    this.workdir = workdir;
    this.servers = new Map(); // name → {config, status, client, tools}
    let saved = {};
    try {
      const r = vault ? vault.readJson(this.file) : { value: undefined };
      saved = r.value ?? {};
    } catch (e) { this.locked = true; console.error('[motor] ' + e.message + ' (mcp.json)'); }
    const seed = Mcp.fromFiles(workdir);
    for (const [n, c] of Object.entries({ ...seed, ...saved })) this.servers.set(n, { config: c, status: { status: c.enabled === false ? 'disabled' : 'disconnected' }, tools: [] });
  }

  /** Servidores MCP declarados en `opencode.json` y `.opencode/opencode.json` de la carpeta de trabajo (`mcp.servers`; gana el segundo). */
  static fromFiles(workdir) {
    const out = {};
    for (const f of ['opencode.json', path.join('.opencode', 'opencode.json')]) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(workdir, f), 'utf8')); } catch { continue; }
      const sv = j?.mcp?.servers ?? j?.mcp;
      if (!sv || typeof sv !== 'object' || Array.isArray(sv)) continue;
      for (const [n, c] of Object.entries(sv)) {
        if (!/^[\w.-]{1,60}$/.test(n) || !c || typeof c !== 'object') continue;
        const type = c.type === 'remote' || (!c.type && c.url) ? 'remote' : 'local';
        if (type === 'local' ? !Array.isArray(c.command) || !c.command.length || c.command.some((x) => typeof x !== 'string') : typeof c.url !== 'string') continue;
        out[n] = { ...c, type };
      }
    }
    return out;
  }

  persist() {
    const o = {};
    for (const [n, s] of this.servers) o[n] = s.config;
    if (this.locked) throw new Error('La configuración MCP está bloqueada: secreto equivocado o archivo alterado');
    this.vault.writeJson(this.file, o);
  }

  list() { return [...this.servers].map(([name, s]) => ({ name, status: s.status })); }
  has(n) { return this.servers.has(n); }
  /** Un servidor MCP «de confianza» (config.trusted=true, lo decide el dueño: p. ej. la ALU local) no marca la sesión como manchada. */
  /** Servidores que siempre mandan sus esquemas (config.alwaysOn=true). */
  alwaysOn() { return new Set([...this.servers].filter(([, s]) => s.config.alwaysOn === true).map(([n]) => n)); }
  trusted(n) { return this.servers.get(n)?.config?.trusted === true; }

  async put(name, config) {
    if (!/^[\w.-]{1,60}$/.test(name)) throw new Error('Nombre de servidor inválido');
    if (config?.type === 'local' ? !Array.isArray(config.command) || !config.command.length : typeof config?.url !== 'string') throw new Error('Configuración MCP inválida');
    await this.disconnect(name);
    this.servers.set(name, { config, status: { status: 'disconnected' }, tools: [] });
    this.persist();
  }

  async remove(name) {
    await this.disconnect(name);
    this.servers.delete(name);
    this.persist();
  }

  async connect(name) {
    const s = this.servers.get(name);
    if (!s) throw new Error('Servidor MCP desconocido');
    await this.disconnect(name);
    try {
      s.client = s.config.type === 'local' ? new StdioRpc(s.config, this.workdir) : new HttpRpc(s.config);
      await s.client.init();
      const r = await s.client.request('tools/list', {}, 20000);
      s.tools = (r.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } }));
      s.status = { status: 'connected' };
    } catch (e) {
      try { s.client?.close(); } catch { /* ya */ }
      s.client = null;
      s.tools = [];
      s.status = { status: 'failed', error: String(e.message ?? e).slice(0, 200) };
    }
    return s.status;
  }

  async disconnect(name) {
    const s = this.servers.get(name);
    if (!s) return;
    try { s.client?.close(); } catch { /* ya */ }
    s.client = null;
    s.tools = [];
    s.status = { status: s.config.enabled === false ? 'disabled' : 'disconnected' };
  }

  /** Herramientas de todos los servidores conectados, con nombre `servidor_herramienta`. */
  tools() {
    const out = [];
    for (const [server, s] of this.servers) for (const t of s.tools) out.push({ server, tool: t.name, name: `${server}_${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64), description: `[MCP ${server}] ${t.description}`, parameters: t.parameters });
    return out;
  }

  async call(server, tool, args, signal) {
    const s = this.servers.get(server);
    if (!s?.client) throw new Error(`El servidor MCP «${server}» no está conectado`);
    const r = await s.client.request('tools/call', { name: tool, arguments: args ?? {} }, 120000);
    signal?.throwIfAborted();
    const content = (r.content ?? []).map((c) => (c.type === 'text' ? { type: 'text', text: String(c.text) } : { type: 'text', text: `[${c.type}${c.mimeType ? ' ' + c.mimeType : ''}]` }));
    return { content: content.length ? content : [{ type: 'text', text: '(sin contenido)' }], isError: !!r.isError };
  }

  /** Al arrancar se reconectan los servidores guardados (en segundo plano, sin bloquear el arranque). */
  async connectAll() { await Promise.allSettled([...this.servers].filter(([, s]) => s.config.enabled !== false).map(([n]) => this.connect(n))); }

  async shutdown() { for (const n of this.servers.keys()) await this.disconnect(n); }
}
