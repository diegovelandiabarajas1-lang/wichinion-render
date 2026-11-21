// Herramientas del agente: read, write, edit, bash, glob, grep, webfetch, websearch (+ skill y MCP desde extras).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveSafe, cleanEnv, safeFetch, SafetyError, redact } from './safety.js';
import { analyzeShell, PROTECTED_WRITE } from './shellpolicy.js';

export class ToolError extends Error {}

const MAX_OUT = 30000;
const clip = (s, n = MAX_OUT) => (s.length > n ? s.slice(0, n * 0.6) + `\n… [${s.length - n} caracteres recortados] …\n` + s.slice(-n * 0.4) : s);
const text = (t, metadata) => ({ content: [{ type: 'text', text: t }], ...(metadata ? { metadata } : {}) });
const rel = (ctx, p) => path.relative(ctx.root, p).split(path.sep).join('/') || '.';
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// ── glob propio ──
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.venv', 'dist', 'build', '.cache']);
export function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = g.indexOf('}', i); if (j > 0) { re += '(?:' + g.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
    else re += /[.+^$()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$', 'i');
}

function* walk(dir, root, depth = 0, budget = { n: 20000 }) {
  if (depth > 25) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    if (budget.n-- <= 0) return;
    if (d.isSymbolicLink()) continue; // no se sigue ningún enlace: evita salir de la carpeta
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) yield* walk(full, root, depth + 1, budget); }
    else if (d.isFile()) yield full;
  }
}

export const TOOLS = {
  read: {
    description: 'Lee un archivo (o lista una carpeta). Devuelve las líneas numeradas. Usa offset/limit para archivos largos.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta del archivo' }, offset: { type: 'integer', description: 'Línea inicial (1)' }, limit: { type: 'integer', description: 'Máximo de líneas (2000)' } }, required: ['path'] },
    permission: (i, ctx) => ({ action: 'read', resources: [rel(ctx, ctx.path(i.path))] }),
    async run(i, ctx) {
      const abs = ctx.path(i.path);
      let st;
      try { st = fs.statSync(abs); } catch { throw new ToolError(`No existe: ${i.path}`); }
      if (st.isDirectory()) {
        const ents = fs.readdirSync(abs, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort();
        return text(ents.join('\n') || '(carpeta vacía)', { kind: 'directory', truncated: false });
      }
      if (st.size > 5 * 1024 * 1024) throw new ToolError('Archivo demasiado grande (más de 5 MB): usa grep o bash');
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) throw new ToolError('Archivo binario: no se puede leer como texto');
      const lines = buf.toString('utf8').split(/\r?\n/);
      const off = Math.max(1, Number(i.offset) || 1);
      const lim = Math.min(Number(i.limit) || 2000, 2000);
      const slice = lines.slice(off - 1, off - 1 + lim).map((l, k) => `${off + k}: ${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`);
      const more = off - 1 + lim < lines.length ? `\n… (${lines.length - (off - 1 + lim)} líneas más; usa offset=${off + lim})` : '';
      return text(`Read file ${rel(ctx, abs)}, lines ${off}-${off + slice.length - 1}\n` + slice.join('\n') + more, { path: rel(ctx, abs), lines: lines.length, truncated: !!more });
    },
  },

  write: {
    description: 'Escribe (crea o reemplaza) un archivo con el contenido dado. Crea las carpetas necesarias.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    permission: (i, ctx) => { const r = rel(ctx, ctx.path(i.path)); const prot = PROTECTED_WRITE.test(r); return { action: 'edit', resources: [r], strict: prot, metadata: { path: i.path, bytes: Buffer.byteLength(String(i.content ?? '')), ...(prot ? { reason: 'archivo de configuración del agente o del proyecto' } : {}) } }; },
    async run(i, ctx) {
      if (typeof i.content !== 'string') throw new ToolError('«content» debe ser texto');
      if (Buffer.byteLength(i.content) > 10 * 1024 * 1024) throw new ToolError('Contenido demasiado grande (más de 10 MB)');
      const abs = ctx.path(i.path);
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, i.content);
      return text(`${existed ? 'Reemplazado' : 'Creado'} ${rel(ctx, abs)} (${i.content.split('\n').length} líneas)`, { path: rel(ctx, abs), created: !existed, truncated: false });
    },
  },

  edit: {
    description: 'Reemplaza texto exacto en un archivo. oldString debe aparecer una sola vez (o usa replaceAll).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldString', 'newString'] },
    permission: (i, ctx) => { const r = rel(ctx, ctx.path(i.path)); const prot = PROTECTED_WRITE.test(r); return { action: 'edit', resources: [r], strict: prot, metadata: { path: i.path, ...(prot ? { reason: 'archivo de configuración del agente o del proyecto' } : {}) } }; },
    async run(i, ctx) {
      const abs = ctx.path(i.path);
      if (typeof i.oldString !== 'string' || typeof i.newString !== 'string') throw new ToolError('oldString y newString deben ser texto');
      if (i.oldString === i.newString) throw new ToolError('oldString y newString son iguales');
      if (!i.oldString) throw new ToolError('oldString está vacío (usa write para crear archivos)');
      let src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch { throw new ToolError(`No existe: ${i.path}`); }
      const n = src.split(i.oldString).length - 1;
      if (n === 0) throw new ToolError('oldString no aparece en el archivo (debe coincidir exactamente, con sangría)');
      if (n > 1 && !i.replaceAll) throw new ToolError(`oldString aparece ${n} veces: da más contexto o usa replaceAll`);
      fs.writeFileSync(abs, i.replaceAll ? src.split(i.oldString).join(i.newString) : src.replace(i.oldString, () => i.newString));
      return text(`Edited ${rel(ctx, abs)} (${n} replacement${n > 1 ? 's' : ''})`, { path: rel(ctx, abs), replacements: n, files: [rel(ctx, abs)], truncated: false });
    },
  },

  shell: {
    description: 'Ejecuta un comando de shell en la carpeta de trabajo y devuelve su salida (stdout+stderr). Tiempo máximo en milisegundos (por defecto 120000).',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer', description: 'ms' }, workdir: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    permission: (i, ctx) => {
      const a = analyzeShell(String(i.command ?? ''), { root: ctx.root, dataDir: ctx.protectedDirs[0] });
      if (a.deny) throw new ToolError('Comando denegado por la política de seguridad: ' + a.deny);
      // cada segmento se aprueba por separado y «siempre» guarda solo comandos EXACTOS (nunca comodines)
      return { action: 'shell', resources: a.segments, save: a.strict ? [] : a.segments, strict: a.strict, metadata: { description: i.description, command: String(i.command ?? '').slice(0, 400), ...(a.strict ? { reasons: a.reasons } : {}) } };
    },
    async run(i, ctx) {
      const cmd = String(i.command ?? '');
      if (!cmd.trim()) throw new ToolError('Comando vacío');
      for (const d of ctx.protectedDirs) if (cmd.toLowerCase().includes(d.toLowerCase().replace(/\\/g, '/')) || cmd.toLowerCase().includes(d.toLowerCase())) throw new ToolError('El comando toca datos protegidos del Motor');
      if (/credentials\.json|permissions\.json|\.git-credentials|\/proc\/\S*\/environ|\bprintenv\b|(^|[;&|\s])env\s*($|[;&|])/.test(cmd)) throw new ToolError('Comando bloqueado: intenta leer secretos o el entorno');
      const cwd = i.workdir ? ctx.path(i.workdir) : ctx.cwd;
      const timeout = Math.min(Math.max(Number(i.timeout) || 120000, 1000), 600000);
      const win = process.platform === 'win32';
      let wrapper = null;
      try { wrapper = process.env.MOTOR_SHELL_WRAPPER ? JSON.parse(process.env.MOTOR_SHELL_WRAPPER) : null; } catch { throw new ToolError('MOTOR_SHELL_WRAPPER inválido (debe ser un arreglo JSON)'); }
      // MOTOR_SHELL_WRAPPER permite ejecutar los comandos en otro lugar aislado, p. ej. ["docker","exec","-i","motor-sandbox","sh","-c"]
      const [bin, args] = wrapper ? [wrapper[0], [...wrapper.slice(1), cmd]] : win ? [process.env.MOTOR_SHELL || 'bash', ['-c', cmd]] : ['/bin/sh', ['-c', cmd]];
      return await new Promise((resolve, reject) => {
        let out = '';
        let killed = '';
        const child = spawn(bin, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true });
        const kill = (why) => {
          killed = why;
          try { if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ya terminó */ } }
        };
        const timer = setTimeout(() => kill('tiempo'), timeout);
        const onAbort = () => kill('interrumpido');
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        const add = (b) => { if (out.length < 400000) out += b.toString('utf8'); };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        child.on('error', (e) => { clearTimeout(timer); reject(new ToolError('No se pudo ejecutar el shell: ' + e.message)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          const body = clip(redact(out, ctx.secrets)) || '(sin salida)';
          if (killed === 'tiempo') return resolve(text(body + `\n\n[Se cortó por superar ${timeout} ms]`, { exit: null, timeout: true, status: 'timeout', truncated: false }));
          if (killed) return reject(new ToolError('Interrumpido'));
          resolve(text(body + (code ? `\n\n[código de salida ${code}]` : ''), { exit: code, status: code ? 'failed' : 'completed', truncated: body.includes('recortados'), signal: null }));
        });
      });
    },
  },

  glob: {
    description: 'Busca archivos por patrón (p. ej. **/*.js). Devuelve hasta 100 rutas, las modificadas más recientemente primero.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Carpeta donde buscar' } }, required: ['pattern'] },
    permission: (i, ctx) => ({ action: 'glob', resources: [rel(ctx, i.path ? ctx.path(i.path) : ctx.cwd)] }),
    async run(i, ctx) {
      const base = i.path ? ctx.path(i.path) : ctx.cwd;
      const re = globToRegExp(String(i.pattern ?? '').replace(/^\.\//, ''));
      const hits = [];
      for (const f of walk(base, ctx.root)) {
        const r = path.relative(base, f).split(path.sep).join('/');
        if (re.test(r)) { try { hits.push({ f, m: fs.statSync(f).mtimeMs }); } catch { /* desapareció */ } }
      }
      hits.sort((a, b) => b.m - a.m);
      const list = hits.slice(0, 100).map((h) => rel(ctx, h.f));
      return text(list.length ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'}\n` + list.join('\n') + (hits.length > 100 ? `\n… (${hits.length - 100} más)` : '') : 'Sin coincidencias', { count: hits.length, truncated: hits.length > 100 });
    },
  },

  grep: {
    description: 'Busca una expresión regular en el contenido de los archivos. Devuelve archivo:línea:texto (máx. 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string', description: 'Patrón de archivos, p. ej. *.js' } }, required: ['pattern'] },
    permission: (i, ctx) => ({ action: 'grep', resources: [rel(ctx, i.path ? ctx.path(i.path) : ctx.cwd)] }),
    async run(i, ctx) {
      let re;
      try { re = new RegExp(String(i.pattern), 'i'); } catch (e) { throw new ToolError('Expresión regular inválida: ' + e.message); }
      if (String(i.pattern).length > 300) throw new ToolError('Patrón demasiado largo');
      const base = i.path ? ctx.path(i.path) : ctx.cwd;
      const inc = i.include ? globToRegExp(i.include.includes('/') ? i.include : '**/' + i.include) : null;
      const out = [];
      let files = 0;
      const t0 = Date.now();
      const stBase = fs.statSync(base, { throwIfNoEntry: false });
      const list = stBase?.isFile() ? [base] : walk(base, ctx.root);
      outer: for (const f of list) {
        const r = path.relative(base, f).split(path.sep).join('/');
        if (inc && !inc.test(r)) continue;
        if (Date.now() - t0 > 15000) { out.push('… (búsqueda cortada por tiempo)'); break; }
        let buf;
        try { if (fs.statSync(f).size > 2 * 1024 * 1024) continue; buf = fs.readFileSync(f); } catch { continue; }
        if (isBinary(buf)) continue;
        files++;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) {
            out.push(`${rel(ctx, f)}:${n + 1}: ${lines[n].slice(0, 300)}`);
            if (out.length >= 100) { out.push('… (más de 100 coincidencias)'); break outer; }
          }
        }
      }
      return text(out.length ? `Found ${out.filter((l) => !l.startsWith('…')).length} matches\n` + out.join('\n') : 'Sin coincidencias', { files, matches: out.length, truncated: out.length >= 100 });
    },
  },

  webfetch: {
    description: 'Descarga una página web (http/https) y devuelve su texto. No accede a direcciones internas.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, format: { type: 'string', enum: ['text', 'html'] } }, required: ['url'] },
    permission: (i) => { let h = ''; try { h = new URL(i.url).hostname; } catch { /* se valida al ejecutar */ } return { action: 'webfetch', resources: [h || String(i.url)] }; },
    async run(i, ctx) {
      let r;
      try { r = await safeFetch(String(i.url), { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)].filter(Boolean)), allowPrivate: ctx.allowPrivateNet, headers: { 'User-Agent': 'WichiMotor/0.2', Accept: 'text/html,text/plain,application/json,*/*;q=0.5' } }); }
      catch (e) { throw new ToolError(e instanceof SafetyError ? e.message : 'No se pudo descargar: ' + (e.cause?.code ?? e.message)); }
      const ct = r.headers.get('content-type') || '';
      if (/^(image|audio|video)\//.test(ct) || isBinary(r.body)) throw new ToolError(`Contenido no textual (${ct || 'binario'})`);
      let body = r.body.toString('utf8');
      if (i.format !== 'html' && /html/.test(ct)) body = htmlToText(body);
      return text(clip(body, 40000), { url: r.url, status: r.status, contentType: ct, truncated: body.includes('recortados') });
    },
  },

  websearch: {
    description: 'Busca en la web y devuelve títulos, enlaces y resúmenes.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    permission: () => ({ action: 'websearch', resources: ['duckduckgo.com'] }),
    async run(i, ctx) {
      const q = String(i.query ?? '').trim();
      if (!q) throw new ToolError('Consulta vacía');
      let r;
      try { r = await safeFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)].filter(Boolean)), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WichiMotor/0.2)' } }); }
      catch (e) { throw new ToolError('Búsqueda no disponible: ' + e.message); }
      const html = r.body.toString('utf8');
      const res = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m;
      while ((m = re.exec(html)) && res.length < 8) {
        let href = m[1];
        const u = href.match(/uddg=([^&]+)/);
        if (u) href = decodeURIComponent(u[1]);
        res.push(`## ${strip(m[2])}\n${href}\n${strip(m[3] ?? '')}`);
      }
      return text(res.length ? res.join('\n\n') : 'Sin resultados', { provider: 'duckduckgo', count: res.length, truncated: false });
    },
  },
};

const strip = (h) => htmlToText(h).replace(/\s+/g, ' ').trim();
export function htmlToText(h) {
  return h
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Contexto de ejecución de una herramienta. */
export function makeCtx({ cfg, session, signal, protectedDirs, secrets }) {
  const root = cfg.workdir;
  const dir = session.location?.directory;
  const cwd = dir && path.isAbsolute(dir) && fs.existsSync(dir) ? (resolveSafe({ root, protectedDirs }, dir)) : root;
  const base = { root, cwd, protectedDirs };
  return {
    root, cwd, signal, protectedDirs, secrets,
    allowPrivateNet: cfg.env?.MOTOR_ALLOW_PRIVATE_NET === '1',
    path: (p) => { try { return resolveSafe(base, p); } catch (e) { throw new ToolError(e.message); } },
  };
}

export const toolSpecs = (extra = []) =>
  [...Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters })), ...extra].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
