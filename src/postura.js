// Autoevaluación de la configuración de seguridad. No incluye secretos: se puede mostrar y registrar.
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './safety.js';

/** @returns {Array<{level:'ok'|'aviso'|'error', id:string, msg:string}>} */
export function posture(cfg, { creds, vault, audit, mcp } = {}) {
  const out = [];
  const add = (level, id, msg) => out.push({ level, id, msg });
  const env = cfg.env ?? {};

  if (!cfg.password && !cfg.passwordHash) add('error', 'auth', 'Sin autenticación (MOTOR_NO_AUTH=1): cualquiera con acceso a la red controla el agente');
  else if (cfg.passwordHash) add('ok', 'auth', 'Contraseña guardada solo como hash scrypt');
  else if (cfg.password.length < 16) add('aviso', 'auth', 'Contraseña de menos de 16 caracteres: usa una larga (node src/hash-password.js --generar)');
  else add('ok', 'auth', 'Contraseña larga');

  if (vault?.active) add('ok', 'boveda', 'Credenciales y configuración MCP cifradas en reposo (AES-256-GCM)');
  else add('aviso', 'boveda', 'Sin secreto de bóveda: las credenciales quedan en texto (modo 0600). Define MOTOR_SECRET');
  if (creds?.locked) add('error', 'boveda-bloqueada', 'credentials.json está sellado y no se pudo abrir (secreto cambiado o archivo alterado)');
  if (mcp?.locked) add('error', 'mcp-bloqueado', 'mcp.json está sellado y no se pudo abrir');

  if (audit?.file) add('ok', 'auditoria', 'Registro de auditoría encadenado (HMAC) en ' + path.basename(audit.file));
  else add('aviso', 'auditoria', 'Sin registro de auditoría');

  if (isInside(cfg.workdir, cfg.dataDir)) add('aviso', 'datos-dentro', 'La carpeta de datos está DENTRO de la carpeta de trabajo (las herramientas la tienen bloqueada, pero sepáralas en producción)');
  else add('ok', 'datos-fuera', 'La carpeta de datos está fuera de la carpeta de trabajo');

  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) add('aviso', 'root', 'Corre como root: usa un usuario sin privilegios (el Dockerfile ya lo hace)');
  if (env.MOTOR_PERMISSIONS === 'allow-all') add('aviso', 'allow-all', 'MOTOR_PERMISSIONS=allow-all: las acciones no estrictas se aprueban solas (las estrictas siguen preguntando)');
  else add('ok', 'permisos', 'Permisos por defecto: escribir, ejecutar y salir a internet preguntan');
  if (env.MOTOR_SHELL_WRAPPER) add('ok', 'shell-aislado', 'Los comandos shell se ejecutan por un envoltorio aislado (MOTOR_SHELL_WRAPPER)');
  else add('aviso', 'shell', 'La herramienta shell corre en este mismo proceso/contenedor: usa contenedor sin privilegios o MOTOR_SHELL_WRAPPER');
  if (env.MOTOR_ALLOW_PRIVATE_NET === '1') add('aviso', 'ssrf', 'webfetch puede llegar a redes privadas (MOTOR_ALLOW_PRIVATE_NET=1)');
  else add('ok', 'ssrf', 'webfetch bloquea redes privadas y metadatos de la nube');
  if (env.MOTOR_CORS) add('aviso', 'cors', 'CORS abierto para: ' + env.MOTOR_CORS);
  const exposed = cfg.host === '0.0.0.0' || cfg.host === '::';
  if (exposed && env.MOTOR_TRUST_PROXY !== '1') add('aviso', 'red', 'Escucha en todas las interfaces sin proxy de confianza: usa TLS delante (Basic viaja en claro por http) o 127.0.0.1');
  else if (!exposed) add('ok', 'red', 'Escucha solo en ' + cfg.host);
  if (process.platform !== 'win32') {
    try {
      const m = fs.statSync(path.join(cfg.dataDir, 'credentials.json')).mode & 0o077;
      add(m ? 'error' : 'ok', 'modo-credenciales', m ? 'credentials.json es legible por otros usuarios' : 'credentials.json con modo 0600');
    } catch { /* aún no existe */ }
  }
  return out;
}
