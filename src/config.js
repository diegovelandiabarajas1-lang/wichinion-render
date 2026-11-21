// Configuración (variables de entorno), credenciales guardadas y catálogo de modelos.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newCredentialId } from './ids.js';
import { isColibri, colibriModel } from './colibri.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.3.2';
/** Versión de OpenCode cuya API imita el Motor. */
export const OPENCODE_API = '2.3.0';

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.MOTOR_DATA || path.join(here, '..', 'data'));
  let password = env.MOTOR_PASSWORD || env.OPENCODE_SERVER_PASSWORD || '';
  const pwFile = env.MOTOR_PASSWORD_FILE;
  if (!password && pwFile) password = fs.readFileSync(pwFile, 'utf8').trim();
  const noAuth = env.MOTOR_NO_AUTH === '1';
  let passwordHash = env.MOTOR_PASSWORD_HASH || '';
  if (!passwordHash && env.MOTOR_PASSWORD_HASH_FILE) passwordHash = fs.readFileSync(env.MOTOR_PASSWORD_HASH_FILE, 'utf8').trim();
  if (!password && !passwordHash && !noAuth) {
    throw new Error('Falta la contraseña: define MOTOR_PASSWORD, MOTOR_PASSWORD_FILE o MOTOR_PASSWORD_HASH (scrypt, ver src/hash-password.js). Solo para pruebas locales: MOTOR_NO_AUTH=1.');
  }
  if (passwordHash && !/^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/.test(passwordHash)) throw new Error('MOTOR_PASSWORD_HASH no tiene el formato scrypt$N$r$p$sal$hash');
  if (password && !passwordHash && password.length < 12 && env.MOTOR_ALLOW_WEAK !== '1') {
    throw new Error('La contraseña es demasiado corta (mínimo 12 caracteres). Genera una con: node src/hash-password.js --generar');
  }
  const secret = env.MOTOR_SECRET || password; // clave de la bóveda (cifrado en reposo)
  const workdir = path.resolve(env.MOTOR_WORKDIR || process.cwd());
  const nimBase = (env.MOTOR_NIM_BASE || (env.MOTOR_BACKEND === 'colibri' ? 'http://127.0.0.1:8000/v1' : 'http://127.0.0.1:8780/v1')).replace(/\/+$/, '');
  const colibri = isColibri(env, nimBase);
  const dm = (env.MOTOR_DEFAULT_MODEL || (colibri ? '' : 'nvidia/nemotron-3.5-lightning-30b-a3b')).trim();
  // Con la contraseña en un archivo (empaquetado en una app local) el servidor escucha solo en este equipo, salvo que se pida otra cosa.
  const host = env.MOTOR_HOST || (!env.MOTOR_PASSWORD && !env.OPENCODE_SERVER_PASSWORD && (pwFile || env.MOTOR_PASSWORD_HASH_FILE) ? '127.0.0.1' : '0.0.0.0');
  return {
    port: Number(env.MOTOR_PORT || env.PORT || 4097),
    host,
    user: env.MOTOR_USER || 'opencode',
    password: passwordHash ? '' : password,
    passwordHash,
    secret,
    dataDir,
    workdir,
    nimBase,
    backend: colibri ? 'colibri' : 'nvidia',
    backendKey: env.MOTOR_BACKEND_KEY || 'colibri', // Colibri acepta cualquier clave no vacía
    contextTokens: Number(env.MOTOR_CONTEXT_TOKENS) || 32768,
    colibriPollMs: Number(env.MOTOR_COLIBRI_POLL_MS) || 3000,
    colibriWaitMs: Number(env.MOTOR_COLIBRI_WAIT_MS) || 20 * 60 * 1000,
    defaultModel: { id: dm, providerID: colibri ? 'colibri' : 'nvidia' },
    projectID: createHash('sha1').update(workdir).digest('hex'),
    env,
  };
}

/** Credenciales (clave de NVIDIA) en `data/credentials.json`, solo lectura para el dueño. */
export class Credentials {
  constructor(dir, env, vault) {
    this.file = path.join(dir, 'credentials.json');
    this.env = env;
    this.vault = vault;
    this.locked = false;
    fs.mkdirSync(dir, { recursive: true });
    this.data = {};
    try {
      const r = vault.readJson(this.file);
      this.data = r.value ?? {};
      if (r.legacy && vault.active && Object.keys(this.data).length) this.save(); // migra el texto en claro a cifrado
    } catch (e) {
      this.locked = true; // sellado y no se puede abrir: no se sobrescribe nunca
      console.error('[motor] ' + e.message + ' (credentials.json); se usará NVIDIA_API_KEY del entorno si existe');
    }
  }

  save() {
    if (this.locked) throw new Error('La bóveda de credenciales está bloqueada: secreto equivocado o archivo alterado');
    this.vault.writeJson(this.file, this.data);
  }

  /** Lista pública (sin la clave) de conexiones de una integración. */
  connections(integrationID) {
    return (this.data[integrationID] ?? []).map(({ id, label, method }) => ({ type: 'credential', id, label, method }));
  }

  addKey(integrationID, key, label) {
    this.data[integrationID] = [{ id: newCredentialId(), label: label || integrationID, method: 'key', key }];
    this.save();
  }

  key(integrationID) {
    const c = this.data[integrationID]?.[0]?.key;
    if (c) return c;
    if (integrationID === 'nvidia') return this.env.NVIDIA_API_KEY || '';
    if (integrationID === 'colibri') return this.env.MOTOR_BACKEND_KEY || 'colibri';
    return '';
  }

  has(integrationID) { return !!this.key(integrationID); }
}

/** Catálogo de modelos de NVIDIA (copia de lo que ofrece OpenCode 2.3.0 en este PC). */
export function nvidiaModels(nimBase) {
  const seed = JSON.parse(fs.readFileSync(path.join(here, 'modelos-nvidia.json'), 'utf8'));
  return seed.map((m) => ({
    ...m,
    settings: { baseURL: nimBase, provider: 'nvidia' },
  }));
}

/** Modelos que ofrece el servidor: el catálogo de NVIDIA, o el único modelo cargado en Colibri (vacío mientras carga). */
export function modelCatalog(cfg) {
  if (cfg.backend === 'colibri') return cfg.defaultModel.id ? [colibriModel(cfg.defaultModel.id, cfg)] : [];
  return nvidiaModels(cfg.nimBase);
}

export function providers(cfg, creds) {
  if (cfg.backend === 'colibri') {
    return [{ id: 'colibri', integrationID: 'colibri', name: 'Colibri (local)', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: cfg.nimBase } }];
  }
  return [
    {
      id: 'nvidia',
      integrationID: 'nvidia',
      name: 'Nvidia',
      activation: creds.has('nvidia') ? 'enabled' : 'auto',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: cfg.nimBase },
    },
  ];
}
