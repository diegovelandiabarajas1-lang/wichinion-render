// Bus de eventos por instancia del Motor + SSE (`GET /api/event`).
import { newEventId } from './ids.js';

export class Bus {
  constructor({ max = 200 } = {}) {
    this.clients = new Set();
    this.max = max;
    this.emit = this.emit.bind(this);
  }

  emit(type, data, extra = {}) {
    const ev = { id: newEventId(), created: Date.now(), type, ...extra, data };
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of this.clients) res.write(line);
    return ev;
  }

  sse(req, res) {
    if (this.clients.size >= this.max) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      return res.end(JSON.stringify({ _tag: 'TooManyStreamsError', message: 'Demasiadas conexiones de eventos' }));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: ' + JSON.stringify({ id: newEventId(), type: 'server.connected', data: {} }) + '\n\n');
    this.clients.add(res);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 10000);
    const done = () => { clearInterval(hb); this.clients.delete(res); };
    req.on('close', done);
    res.on('error', done);
  }

  count() { return this.clients.size; }
  closeAll() { for (const r of this.clients) r.end(); this.clients.clear(); }
}
