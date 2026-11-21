// Reducción de lo que se manda al modelo en cada paso (el coste real de un agente largo):
//  1) esquemas de herramientas MCP compactos;
//  2) herramientas MCP «a demanda»: solo se envían los esquemas de los servidores que la conversación nombra o ya usó
//     (el resto se anuncia en una línea y se activa con `mcp_activar`);
//  3) en el historial, los argumentos enormes de llamadas viejas (el contenido de un `write`) y las salidas viejas se recortan.
// Todo se desactiva con MOTOR_CONTEXT_TRIM=0 (para comparar).

const DROP_KEYS = new Set(['$schema', 'additionalProperties', 'default', 'examples', 'example', 'title', '$id', '$comment']);

/** Esquema JSON sin ruido: sin descripciones largas, ejemplos ni valores por omisión. */
export function compactSchema(s, maxDesc = 70) {
  if (Array.isArray(s)) return s.map((x) => compactSchema(x, maxDesc));
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'description' && typeof v === 'string') { out[k] = v.length > maxDesc ? v.slice(0, maxDesc - 1).trimEnd() + '…' : v; continue; }
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, compactSchema(x, maxDesc)])) : compactSchema(v, maxDesc);
  }
  return out;
}

export const compactTool = (t) => ({ ...t, description: String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 160), parameters: compactSchema(t.parameters) });

/**
 * Servidores MCP cuyos esquemas se envían ahora: los marcados `alwaysOn`, los nombrados en algún mensaje del usuario,
 * los que ya se usaron y los activados con `mcp_activar`.
 */
export function exposedServers(messages, servers, alwaysOn = new Set()) {
  const on = new Set(alwaysOn);
  const names = servers.map((x) => x.toLowerCase());
  for (const m of messages) {
    if ((m.type === 'user' || m.type === 'synthetic') && typeof m.text === 'string') {
      const t = m.text.toLowerCase();
      names.forEach((n, i) => { if (new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) on.add(servers[i]); });
    } else if (m.type === 'assistant') {
      for (const p of m.content ?? []) {
        if (p.type !== 'tool') continue;
        if (p.name === 'mcp_activar' && typeof p.state?.input?.server === 'string') on.add(p.state.input.server);
        for (const sv of servers) if (p.name?.startsWith(sv + '_')) on.add(sv);
      }
    }
  }
  return on;
}

/** Línea para el prompt del sistema con los servidores MCP aún no activados. */
export function catalogoMcp(pending) {
  if (!pending.length) return '';
  const l = pending.map(({ server, tools }) => `- ${server}: ${tools.slice(0, 40).map((t) => t.tool).join(', ')}`).join('\n');
  return `Servidores MCP disponibles pero NO activados (sus herramientas no aparecen aún). Si una tarea los necesita, llama primero a \`mcp_activar\` con el nombre del servidor:\n${l}`;
}

export const MCP_ACTIVAR = {
  name: 'mcp_activar',
  description: 'Activa un servidor MCP para poder usar sus herramientas en los pasos siguientes.',
  parameters: { type: 'object', properties: { server: { type: 'string', description: 'Nombre del servidor' } }, required: ['server'] },
};

const omit = (s, keep = 0) => `«${s.length - keep} caracteres omitidos»`;

/**
 * Recorta el historial en formato OpenAI. Se conservan intactos los últimos `recent` mensajes.
 * - argumentos de llamadas viejas: textos de más de 400 caracteres → marca corta (el archivo ya está escrito en disco);
 * - resultados viejos de más de 1 500 caracteres → cabeza y cola.
 */
export function trimHistory(msgs, { recent = 6 } = {}) {
  const limit = msgs.length - recent;
  for (let i = 1; i < limit; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls) {
      for (const c of m.tool_calls) {
        const a = c.function.arguments;
        if (a.length < 600) continue;
        try {
          const o = JSON.parse(a);
          let cambio = false;
          for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v.length > 400) { o[k] = omit(v); cambio = true; }
          if (cambio) c.function.arguments = JSON.stringify(o);
        } catch { /* argumentos no JSON: se dejan */ }
      }
    } else if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 1500) {
      m.content = m.content.slice(0, 700) + `\n… [recortado: ${m.content.length - 1200} caracteres de un resultado antiguo] …\n` + m.content.slice(-500);
    }
  }
  return msgs;
}
