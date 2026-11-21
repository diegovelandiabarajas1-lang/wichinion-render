// Bóveda: cifrado en reposo (AES-256-GCM) con una clave derivada con scrypt del secreto del Motor.
// Formato de un valor sellado: wvault1:<iv b64url>:<tag b64url>:<texto cifrado b64url>. El «AAD» ata cada valor a su
// propósito (p. ej. el nombre del archivo), de modo que no se puede copiar un valor sellado a otro sitio.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PREFIX = 'wvault1:';
export class VaultLocked extends Error {}

export class Vault {
  /** @param {string} dir carpeta de datos (guarda `vault.salt`, que no es secreto) @param {string} secret */
  constructor(dir, secret) {
    this.active = !!secret;
    this.key = null;
    if (!this.active) return;
    fs.mkdirSync(dir, { recursive: true });
    const saltFile = path.join(dir, 'vault.salt');
    let salt;
    try { salt = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'base64url'); } catch { /* primera vez */ }
    if (!salt || salt.length !== 16) {
      salt = crypto.randomBytes(16);
      fs.writeFileSync(saltFile, salt.toString('base64url'), { mode: 0o600 });
    }
    this.key = crypto.scryptSync(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  }

  static isSealed(text) { return typeof text === 'string' && text.startsWith(PREFIX); }

  seal(plain, aad = '') {
    if (!this.active) throw new Error('Bóveda inactiva');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
    return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
  }

  open(text, aad = '') {
    if (!this.active) throw new VaultLocked('Hay datos cifrados y falta MOTOR_SECRET (o MOTOR_PASSWORD)');
    try {
      const [iv, tag, ct] = text.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new VaultLocked('No se pudo descifrar: secreto equivocado o archivo alterado');
    }
  }

  /** Lee un JSON (sellado o en claro heredado). Devuelve {value, legacy}. Lanza VaultLocked si está sellado y no se puede abrir. */
  readJson(file, aad = path.basename(file)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { value: undefined, legacy: false }; }
    if (Vault.isSealed(raw.trim())) return { value: JSON.parse(this.open(raw.trim(), aad)), legacy: false };
    return { value: JSON.parse(raw), legacy: true };
  }

  writeJson(file, value, aad = path.basename(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, this.active ? this.seal(JSON.stringify(value), aad) : JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

// ── Contraseñas con hash (scrypt) ──
/** Formato: scrypt$N$r$p$salt(b64url)$hash(b64url) */
export function hashPassword(password, { N = 2 ** 15, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored || '');
  if (!m) return false;
  const [, N, r, p, salt, hash] = m;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
