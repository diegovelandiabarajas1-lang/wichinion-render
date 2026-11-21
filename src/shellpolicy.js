// Política de la herramienta `shell`: analiza el comando ANTES de pedir permiso.
//  - lo parte en segmentos (; && || | & salto de línea) para que cada uno se apruebe por separado,
//  - deniega de forma dura lo peligroso aunque haya reglas «allow»,
//  - marca como «estricto» lo que no se puede analizar (sustituciones, variables, intérpretes en línea, red,
//    rutas fuera de la carpeta, archivos de configuración): en ese caso solo valen reglas exactas, nunca comodines.
// Es un filtro de mejor esfuerzo, no un sandbox: la barrera real es el permiso del usuario y el contenedor.
import path from 'node:path';

const DENY_CMDS = new Set([
  'sudo', 'su', 'doas', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'mkfs', 'fdisk', 'parted', 'mount', 'umount',
  'chown', 'chgrp', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'crontab', 'at', 'batch', 'docker', 'podman', 'kubectl', 'nsenter',
  'systemctl', 'service', 'iptables', 'nft', 'passwd', 'useradd', 'userdel', 'usermod', 'visudo', 'insmod', 'modprobe', 'setcap',
  'powershell', 'pwsh', 'cmd', 'reg', 'schtasks', 'wmic', 'sc', 'net', 'runas', 'bcdedit', 'diskpart', 'format', 'cipher',
]);
const NETWORK_CMDS = new Set(['curl', 'wget', 'ftp', 'tftp', 'rsync', 'git-remote', 'gh', 'aws', 'gcloud', 'az', 'ping', 'dig', 'nslookup', 'host']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'eval', 'exec', 'source', '.', 'xargs', 'env', 'find', 'awk', 'gawk', 'sed', 'perl', 'python', 'python3', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'php', 'lua', 'tclsh']);
const SENSITIVE_ABS = /^(\/etc|\/proc|\/sys|\/root|\/home|\/var|\/boot|\/dev(?!\/(null|zero|stdout|stderr|stdin|urandom|random)$)|\/run|\/mnt|\/media|\/srv|[A-Za-z]:[\\/](Windows|Users|Program Files|ProgramData))/i;
const SAFE_ABS = /^(\/dev\/(null|zero|stdout|stderr|stdin|urandom|random)|\/tmp(\/|$)|\/usr\/(bin|lib|share|local)\/|\/bin\/|\/lib\/|\/opt\/)/;
/** Archivos y carpetas de configuración del agente/proyecto: tocarlos exige permiso expreso cada vez. */
export const PROTECTED_WRITE = /(^|\/)(\.git(\/|$)|\.opencode(\/|$)|\.claude(\/|$)|\.agents(\/|$)|\.vscode(\/|$)|\.github(\/|$)|\.husky(\/|$)|AGENTS\.md$|CLAUDE\.md$|opencode\.json$|\.(bashrc|bash_profile|zshrc|profile|npmrc|netrc|gitconfig)$)/i;

/** Parte un comando en segmentos respetando comillas. Devuelve también las banderas de lo no analizable. */
export function splitShell(cmd) {
  const segs = [];
  let cur = '';
  let q = null; // ' o "
  const flags = { subst: false, vars: false, heredoc: false, redirects: [], backslashNewline: false };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === '\\') { cur += c + (n ?? ''); if (n === '\n') flags.backslashNewline = true; i++; continue; }
    if (q === '"') {
      cur += c;
      if (c === '"') q = null;
      else if (c === '`' || (c === '$' && n === '(')) flags.subst = true;
      else if (c === '$' && /[A-Za-z_{@*#?0-9!$-]/.test(n ?? '')) flags.vars = true;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '`' || (c === '$' && n === '(') || ((c === '<' || c === '>') && n === '(')) { flags.subst = true; cur += c; continue; }
    if (c === '$' && /[A-Za-z_{@*#?0-9!$-]/.test(n ?? '')) { flags.vars = true; cur += c; continue; }
    if (c === '<' && n === '<') { flags.heredoc = true; cur += c; continue; }
    if (c === '>' ) {
      // redirección: se guarda el destino para comprobarlo
      const m = cmd.slice(i).match(/^>>?&?\s*([^\s;&|<>]+)/);
      if (m) flags.redirects.push(m[1].replace(/^['"]|['"]$/g, ''));
      cur += c; continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && n === c) i++;
      if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || n === '>')) { cur += c; continue; } // 2>&1, &>
      if (cur.trim()) segs.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (q) flags.unbalanced = true;
  if (cur.trim()) segs.push(cur.trim());
  return { segs, flags };
}

/** Palabras de un segmento sin comillas externas (suficiente para clasificar). */
export function words(seg) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, '$1'));
  return out;
}

const norm = (p) => p.replace(/\\/g, '/');
const inside = (root, p) => { const r = path.posix.relative(norm(root).toLowerCase(), norm(p).toLowerCase()); return r === '' || (!r.startsWith('..') && !path.posix.isAbsolute(r)); };

/**
 * @returns {{segments:string[], strict:boolean, reasons:string[], deny:string|null}}
 */
export function analyzeShell(cmd, { root, dataDir } = {}) {
  const reasons = [];
  let deny = null;
  const { segs, flags } = splitShell(cmd);
  if (flags.unbalanced) reasons.push('comillas sin cerrar');
  if (flags.subst) reasons.push('sustitución de comandos');
  if (flags.vars) reasons.push('variables de shell');
  if (flags.heredoc) reasons.push('here-document');
  if (flags.backslashNewline) reasons.push('continuación de línea');
  if (segs.length > 8) reasons.push('muchos comandos encadenados');

  const dataLow = dataDir ? norm(dataDir).toLowerCase() : null;
  const targets = [...flags.redirects];
  for (const seg of segs) {
    let w = words(seg);
    // quitar prefijos que no cambian el comando real
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || ['command', 'builtin', 'nohup', 'time', 'nice', 'exec'].includes(w[0]))) {
      if (w[0] === 'exec') reasons.push('exec');
      w = w.slice(1);
    }
    if (!w.length) continue;
    const cmdName = w[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    const args = w.slice(1);
    if (DENY_CMDS.has(cmdName) || /^mkfs\./.test(cmdName)) deny = deny ?? `comando no permitido: ${cmdName}`;
    if (cmdName === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) deny = deny ?? 'dd hacia un dispositivo';
    if (cmdName === 'chmod' && args.some((a) => /^-[a-z]*R/.test(a)) && args.some((a) => a.startsWith('/') || a === '..')) deny = deny ?? 'chmod recursivo fuera de la carpeta';
    if (cmdName === 'rm' && args.some((a) => /^-[a-zA-Z]*[rRfF]/.test(a))) {
      const t = args.filter((a) => !a.startsWith('-'));
      if (t.some((a) => a === '/' || a === '~' || a === '.' || a === '..' || a === '*' || a === '/*' || a.startsWith('~/') || /^\.\.(\/|$)/.test(a) || (a.startsWith('/') && !inside(root ?? '/nonexistent', a)))) deny = deny ?? 'rm recursivo peligroso';
    }
    if (/(^|\/)(bash|sh|zsh|dash)$/.test(cmdName) && args.some((a) => a === '-i' || /\/dev\/tcp\//.test(a))) deny = deny ?? 'shell interactivo o /dev/tcp';
    if (/(^|[\s'"=])[A-Za-z]:[\\/](Windows|Users|Program Files|ProgramData)/i.test(seg)) deny = deny ?? 'ruta del sistema de Windows';
    if (/\/dev\/(tcp|udp)\//.test(seg)) deny = deny ?? 'conexión por /dev/tcp';
    if (/\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(seg) || /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/.test(cmd)) deny = deny ?? 'descargar y ejecutar (curl | sh)';
    if (/(^|\s)(~\/\.ssh|\.ssh\/|\/\.aws\/|\.gnupg)/.test(seg)) deny = deny ?? 'claves personales (~/.ssh, ~/.aws, ~/.gnupg)';
    if (INTERPRETERS.has(cmdName) && args.some((a) => ['-c', '-e', '--eval', '-p', '-r', '-E', '-exec', '-ex', '--exec'].includes(a) || /^-[a-z]*c$/.test(a))) reasons.push(`código en línea (${cmdName})`);
    if (['eval', 'source', '.', 'xargs'].includes(cmdName)) reasons.push(cmdName);
    if (NETWORK_CMDS.has(cmdName)) reasons.push(`red (${cmdName})`);
    if (cmdName === 'git' && args.some((a) => ['push', 'pull', 'fetch', 'clone', 'remote', 'config', 'submodule'].includes(a))) reasons.push('git con red/configuración');
    if (['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'cargo', 'go', 'gem', 'composer', 'apt', 'apt-get', 'apk', 'brew', 'bun', 'deno'].includes(cmdName) && args.some((a) => ['install', 'i', 'add', 'run', 'exec', 'x', 'get', 'update', 'upgrade', 'create', 'init', 'dlx'].includes(a))) reasons.push(`instalación/ejecución de paquetes (${cmdName})`);
    for (const a of args) if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) reasons.push('URL en el comando');
    for (const t of [...args, ...(cmdName === 'cd' ? [] : [])]) targets.push(t);
  }

  for (const t0 of targets) {
    const t = norm(t0.replace(/^[A-Za-z0-9_-]+=/, '')); // --opt=ruta
    if (!t || t.startsWith('-')) {
      const eq = t0.match(/^--?[A-Za-z0-9-]+=(.+)$/);
      if (!eq) continue;
    }
    const p = norm(t0.replace(/^--?[A-Za-z0-9-]+=/, ''));
    if (/(^|\/)\.\.(\/|$)/.test(p)) reasons.push('sube de carpeta (..)');
    if (p.startsWith('~')) { reasons.push('carpeta personal (~)'); if (/^~[^/]*\/(\.|etc|\.ssh)/.test(p)) deny = deny ?? 'carpeta personal'; }
    const abs = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
    if (abs) {
      if (dataLow && p.toLowerCase().startsWith(dataLow)) deny = deny ?? 'datos internos del Motor';
      else if (SENSITIVE_ABS.test(p) && !(root && inside(root, p))) deny = deny ?? `ruta del sistema: ${p.slice(0, 40)}`;
      else if (!SAFE_ABS.test(p) && !(root && inside(root, p))) reasons.push('ruta fuera de la carpeta de trabajo');
    }
    if (PROTECTED_WRITE.test(p.replace(/^\.\//, ''))) reasons.push('archivo de configuración del agente o del proyecto');
  }

  // Lo que se aprueba es cada segmento tal cual, recortado.
  const segments = [...new Set(segs.map((s) => s.slice(0, 400)))];
  return { segments: segments.length ? segments : [cmd.trim().slice(0, 400)], strict: reasons.length > 0, reasons: [...new Set(reasons)], deny };
}
