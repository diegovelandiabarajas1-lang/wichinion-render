// Rutas de permisos, comandos, skills, MCP, exportar/importar y estadísticas.
import { loadCommands, loadSkills, publicCommand, publicSkill, renderTemplate } from './instructions.js';
import { OPENCODE_API } from './config.js';

export function addRoutes({ emit, route, cfg, store, perms, mcp, runner, getSession, SES_RE, locOf, HttpError, badRequest, audit, getPosture }) {
  const nf = (tag, what, id) => new HttpError(404, { _tag: tag, message: `${what} not found: ${id}` });

  // ── Comando de la conversación ──
  route('POST', '/api/session/{id}/command', ({ params, body }) => {
    const { session: s } = getSession(params.id);
    if (!body || typeof body.name !== 'string') throw badRequest('Falta «name»');
    const cmd = loadCommands(cfg.workdir).find((c) => c.name === body.name);
    if (!cmd) throw nf('CommandNotFoundError', 'Command', body.name);
    if (cmd.model && /^[\w.-]+\/.+/.test(cmd.model)) {
      const [providerID, ...r] = cmd.model.split('/');
      s.model = { id: r.join('/'), providerID, variant: 'default' };
    }
    runner.prompt(s, { text: renderTemplate(cmd.template, String(body.text ?? '')), files: body.files, delivery: body.delivery, metadata: { command: cmd.name } });
    return 204;
  });

  // ── Permisos ──
  route('GET', '/api/permission/request', ({ q }) => ({ ...locOf(q), data: perms.list() }));
  route('GET', '/api/permission/saved', () => ({ data: perms.listSaved() }));
  route('PATCH', '/api/permission/saved/{id}', ({ params, body }) => {
    if (!perms.patchSaved(params.id, body ?? {})) throw nf('PermissionSavedNotFoundError', 'Saved permission', params.id);
    return 204;
  });
  route('DELETE', '/api/permission/saved/{id}', ({ params }) => {
    if (!perms.deleteSaved(params.id)) throw nf('PermissionSavedNotFoundError', 'Saved permission', params.id);
    return 204;
  });
  route('GET', '/api/session/{id}/permission', ({ params }) => (getSession(params.id), { data: perms.list(params.id) }));
  route('GET', '/api/session/{id}/permission/{rid}', ({ params }) => {
    getSession(params.id);
    const r = perms.get(params.id, params.rid);
    if (!r) throw nf('PermissionNotFoundError', 'Permission request', params.rid);
    return { data: r };
  });
  route('POST', '/api/session/{id}/permission/{rid}/reply', ({ params, body }) => {
    getSession(params.id);
    if (!['once', 'always', 'reject'].includes(body?.decision)) throw badRequest('«decision» debe ser once, always o reject');
    if (!perms.reply(params.id, params.rid, body.decision, body.message || undefined)) throw nf('PermissionNotFoundError', 'Permission request', params.rid);
    return 204;
  });

  // ── Comandos, skills y MCP ──
  route('GET', '/api/command', ({ q }) => ({ ...locOf(q), data: loadCommands(cfg.workdir).map(publicCommand) }));
  route('GET', '/api/skill', ({ q }) => ({ ...locOf(q), data: loadSkills(cfg.workdir).map(publicSkill) }));
  route('GET', '/api/mcp', ({ q }) => ({ ...locOf(q), data: mcp.list() }));
  route('PUT', '/api/experimental/mcp/{name}', async ({ params, body }) => {
    try { await mcp.put(params.name, body?.config); } catch (e) { throw badRequest(e.message); }
    return 204;
  });
  const needMcp = (n) => { if (!mcp.has(n)) throw nf('McpNotFoundError', 'MCP server', n); };
  route('DELETE', '/api/experimental/mcp/{name}', async ({ params }) => { needMcp(params.name); await mcp.remove(params.name); return 204; });
  route('POST', '/api/experimental/mcp/{name}/connect', async ({ params }) => { needMcp(params.name); await mcp.connect(params.name); return 204; });
  route('POST', '/api/experimental/mcp/{name}/disconnect', async ({ params }) => { needMcp(params.name); await mcp.disconnect(params.name); return 204; });

  // ── Seguridad: auditoría y postura (sin secretos) ──
  route('GET', '/api/experimental/audit', ({ q }) => {
    const n = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
    return { data: { verify: audit.verify(), entries: audit.tail(n) } };
  });
  route('GET', '/api/experimental/security', () => ({ data: getPosture() }));

  // ── Estadísticas, exportar e importar ──
  route('GET', '/api/experimental/session/stats', ({ q }) => {
    const from = Number(q.get('from')) || 0;
    const to = Number(q.get('to')) || Date.now();
    const all = [...store.map.values()].filter((e) => e.session.time.created >= from && e.session.time.created <= to);
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    let steps = 0, prompts = 0, cost = 0;
    for (const e of all) {
      cost += e.session.cost ?? 0;
      for (const k of ['input', 'output', 'reasoning']) tokens[k] += e.session.tokens?.[k] ?? 0;
      tokens.cache.read += e.session.tokens?.cache?.read ?? 0;
      tokens.cache.write += e.session.tokens?.cache?.write ?? 0;
      for (const m of e.messages) { if (m.type === 'assistant') steps++; else if (m.type === 'user') prompts++; }
    }
    return { data: { range: { from, to }, sessions: all.length, subagents: all.filter((e) => e.session.parentID).length, prompts, steps, tokens, cost, tools: { mode: 'none' } } };
  });
  route('GET', '/api/experimental/session/{id}/export', ({ params }) => {
    const e = getSession(params.id);
    return { data: { info: e.session, messages: e.messages } };
  });
  route('POST', '/api/experimental/session/import', ({ body }) => {
    const info = body?.info;
    const msgs = body?.messages;
    if (!info || typeof info !== 'object' || !SES_RE.test(String(info.id)) || !Array.isArray(msgs)) throw badRequest('Se esperaba {info, messages}');
    const okMsg = (m) => m && typeof m === 'object' && /^msg_[A-Za-z0-9]+$/.test(String(m.id)) && /^[a-z][a-z-]{0,40}$/.test(String(m.type)); // user, assistant, idle, synthetic, system, model-switched, agent-switched…
    if (!msgs.every(okMsg)) throw badRequest('Mensaje inválido en la importación');
    if (store.has(info.id)) throw new HttpError(409, { _tag: 'SessionExistsError', message: `Session already exists: ${info.id}` });
    const s = store.create({ id: info.id, parentID: info.parentID, agent: info.agent, model: info.model ?? { ...cfg.defaultModel, variant: 'default' }, directory: info.location?.directory || cfg.workdir, metadata: info.metadata, projectID: cfg.projectID });
    Object.assign(s, { cost: Number(info.cost) || 0, tokens: info.tokens ?? s.tokens, time: { ...s.time, ...(info.time ?? {}) } });
    if (info.title) s.title = String(info.title);
    if (info.outcome) s.outcome = info.outcome;
    if (s.time.busy && !(s.time.idle >= s.time.busy)) s.time.idle = Date.now();
    store.get(s.id).messages.push(...msgs);
    store.save(s.id, true);
    emit('session.created', { sessionID: s.id, slug: s.id.slice(-8).toLowerCase(), version: OPENCODE_API, projectID: s.projectID, location: s.location, subpath: '', model: { id: s.model.id, providerID: s.model.providerID } }, { location: s.location });
    return { data: s };
  });
}
