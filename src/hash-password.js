// Genera una contraseña larga o el hash scrypt de una contraseña, para no dejar la contraseña en texto en el entorno.
//   node src/hash-password.js --generar        → imprime una contraseña nueva y su hash
//   node src/hash-password.js "mi contraseña"  → imprime solo el hash (MOTOR_PASSWORD_HASH=…)
import crypto from 'node:crypto';
import { hashPassword } from './vault.js';

const arg = process.argv[2];
if (!arg) { console.error('Uso: node src/hash-password.js --generar | "contraseña"'); process.exit(2); }
if (arg === '--generar') {
  const pw = crypto.randomBytes(24).toString('base64url');
  console.log('Contraseña (guárdala en tu gestor; úsala en los clientes):\n' + pw + '\n\nMOTOR_PASSWORD_HASH=' + hashPassword(pw));
} else {
  if (arg.length < 12) { console.error('Mínimo 12 caracteres'); process.exit(1); }
  console.log('MOTOR_PASSWORD_HASH=' + hashPassword(arg));
}
