// Verifica la cadena del registro de auditoría.  node src/audit-verify.js [archivo]   (MOTOR_SECRET o MOTOR_PASSWORD en el entorno)
import path from 'node:path';
import { verifyFile } from './audit.js';

const file = process.argv[2] || path.join(process.env.MOTOR_DATA || './data', 'audit.log');
const r = verifyFile(file, process.env.MOTOR_SECRET || process.env.MOTOR_PASSWORD || '');
console.log(r.ok ? `OK: ${r.entries} entradas, cadena íntegra` : `ROTA en la línea ${r.brokenAt}: ${r.why}`);
process.exit(r.ok ? 0 : 1);
