// Registro de auditoría a prueba de manipulación: JSON por línea, cada entrada lleva el MAC (HMAC-SHA256) de la anterior.
// Quien altere, borre o reordene una línea del medio rompe la cadena (se detecta con `verify`). Con secreto, tampoco
// se puede rehacer la cadena sin conocerlo. Límite: borrar las ÚLTIMAS líneas no se nota; para eso, `MOTOR_AUDIT_STDOUT=1`
// envía cada entrada también a la salida estándar (docker logs) para guardarla fuera del servidor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);
const macKey = (secret) => crypto.createHash('sha256').update('wichi-audit-v1:' + (secret || '')).digest();
const mac = (key, prev, body) => crypto.createHmac('sha256', key).update(prev + '\n' + body).digest('hex');
const canon = (e) => JSON.stringify([e.seq, e.ts, e.type, e.data]);

export class Audit {
  constructor({ file, secret = '', maxBytes = 20 * 1024 * 1024, redact = (x) => x, stdout = false } = {}) {
    this.file = file;
    this.key = macKey(secret);
    this.maxBytes = maxBytes;
    this.redact = redact;
    this.stdout = stdout;
    this.seq = 0;
    this.prev = GENESIS;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        this.seq = last.seq;
        this.prev = last.mac;
      } catch { /* archivo nuevo o vacío */ }
    }
  }

  /** Anota un hecho. `data` se redacta (claves) y se recorta. Nunca lanza. */
  log(type, data = {}) {
    try {
      const safe = JSON.parse(this.redact(JSON.stringify(data, (k, v) => (typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v))));
      const e = { seq: ++this.seq, ts: Date.now(), type, data: safe };
      e.prev = this.prev;
      e.mac = mac(this.key, this.prev, canon(e));
      this.prev = e.mac;
      const line = JSON.stringify(e);
      if (this.file) {
        try { if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, this.file + '.1'); } catch { /* aún no existe */ }
        fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
      }
      if (this.stdout) process.stdout.write('AUDIT ' + line + '\n');
      return e;
    } catch { return null; }
  }

  tail(n = 100) {
    if (!this.file) return [];
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
  }

  verify() { return verifyFile(this.file, this.key); }
}

/** Comprueba la cadena de un archivo. `key` = clave ya derivada o secreto en texto. */
export function verifyFile(file, keyOrSecret = '') {
  const key = Buffer.isBuffer(keyOrSecret) ? keyOrSecret : macKey(keyOrSecret);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return { ok: true, entries: 0 }; }
  let prev = null;
  let seq = null;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, entries: i, brokenAt: i + 1, why: 'línea ilegible' }; }
    if (prev !== null && e.prev !== prev) return { ok: false, entries: i, brokenAt: i + 1, why: 'cadena rota (entrada borrada o reordenada)' };
    if (seq !== null && e.seq !== seq + 1) return { ok: false, entries: i, brokenAt: i + 1, why: 'salto de número de secuencia' };
    if (mac(key, e.prev, canon(e)) !== e.mac) return { ok: false, entries: i, brokenAt: i + 1, why: 'entrada alterada (MAC no coincide)' };
    prev = e.mac;
    seq = e.seq;
  }
  return { ok: true, entries: lines.length, head: prev };
}
