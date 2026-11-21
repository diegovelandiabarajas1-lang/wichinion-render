// Identificadores con la forma de OpenCode: ses_<12 hex><14 base62>, msg_..., evt_...
import { randomBytes, randomUUID } from 'node:crypto';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let last = 0;
let counter = 0;

function rand62(n) {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += B62[b[i] % 62];
  return s;
}

/** 12 dígitos hex derivados del reloj (creciente) y un contador. */
function stamp() {
  const now = Date.now();
  if (now !== last) { last = now; counter = 0; }
  counter++;
  return (BigInt(now) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0').slice(-12);
}

export const newMessageId = () => 'msg_' + stamp() + rand62(14);
export const newEventId = () => 'evt_' + stamp() + rand62(14);
export const newCredentialId = () => 'cred_' + stamp() + rand62(14);
export const newPermissionId = () => 'per_' + stamp() + rand62(14);
/** Las sesiones se ordenan al revés (las más nuevas primero), como en OpenCode. */
export function newSessionId() {
  const inv = (0xffffffffffffn - BigInt('0x' + stamp())).toString(16).padStart(12, '0').slice(-12);
  return 'ses_' + inv + rand62(14);
}
export const newCallId = () => 'call-' + randomUUID();
