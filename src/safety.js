// Barreras de seguridad: confinamiento de rutas, entorno limpio para procesos hijos,
// protección contra SSRF y redacción de secretos.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

export class SafetyError extends Error {}

const realpathDeep = (p) => {
  // realpath del ancestro existente más cercano + el resto (para rutas que aún no existen)
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
};

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
export const isInside = (root, p) => {
  const r = path.relative(norm(root), norm(p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/** Nombres de archivo que nunca se leen ni escriben aunque estén dentro de la carpeta de trabajo. */
const SECRET_NAMES = /(^|[\\/])(\.env(\..*)?|credentials\.json|permissions\.json|mcp\.json|id_rsa|id_ed25519|\.npmrc|\.netrc|\.git-credentials)$/i;

/**
 * Resuelve `p` (relativa a `cwd`) y comprueba que, siguiendo enlaces simbólicos, cae dentro de
 * `root` y fuera de las rutas protegidas. Devuelve la ruta absoluta.
 */
export function resolveSafe({ root, cwd, protectedDirs = [] }, p, { allowSecrets = false } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new SafetyError('Ruta inválida');
  const abs = path.resolve(cwd || root, p);
  const realRoot = realpathDeep(root);
  const real = realpathDeep(abs);
  if (!isInside(realRoot, real)) throw new SafetyError(`Ruta fuera de la carpeta de trabajo (${root}): ${p}. Usa rutas relativas a esa carpeta.`);
  for (const d of protectedDirs) if (isInside(realpathDeep(d), real)) throw new SafetyError('Ruta protegida del Motor');
  if (!allowSecrets && SECRET_NAMES.test(real)) throw new SafetyError('Archivo de secretos: acceso denegado');
  return abs;
}

/** Entorno para procesos hijos (bash, MCP local): sin claves, tokens ni variables del Motor. */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|^MOTOR_|^OPENCODE_|^NVIDIA|AUTH/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── SSRF ──
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
  }
  return true;
}

export async function assertPublicUrl(u, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(u); } catch { throw new SafetyError('URL inválida'); }
  if (!/^https?:$/.test(url.protocol)) throw new SafetyError('Solo http(s)');
  if (url.username || url.password) throw new SafetyError('URL con credenciales: no permitido');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) throw new SafetyError('Dirección interna: bloqueada');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new SafetyError('No se pudo resolver el nombre'); });
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new SafetyError('Dirección privada o interna: bloqueada (SSRF)');
  return url;
}

/** fetch que revalida cada redirección y limita el tamaño. */
export async function safeFetch(u, { signal, maxBytes = 5 * 1024 * 1024, headers, allowPrivate = false, maxRedirects = 5 } = {}) {
  let cur = u;
  for (let i = 0; i <= maxRedirects; i++) {
    const url = await assertPublicUrl(cur, { allowPrivate });
    const res = await fetch(url, { redirect: 'manual', signal, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), url).href;
      continue;
    }
    const chunks = [];
    let n = 0;
    const rd = res.body?.getReader();
    if (rd) {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        n += value.length;
        if (n > maxBytes) { rd.cancel().catch(() => {}); throw new SafetyError('Respuesta demasiado grande'); }
        chunks.push(value);
      }
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), url: url.href };
  }
  throw new SafetyError('Demasiadas redirecciones');
}

/** Oculta claves conocidas en un texto (para registros y salidas de herramientas). */
export function redact(text, secrets = []) {
  let t = String(text);
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join('«secreto»');
  return t.replace(/nvapi-[A-Za-z0-9_-]{20,}/g, 'nvapi-«secreto»').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, '$1«secreto»');
}
