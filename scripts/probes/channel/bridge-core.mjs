// Small diagnostic bridge: one authenticated principal per session, no model calls here.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function createBridge({ tokens, deliverCodex, onEvent = () => {} }) {
  const messages = new Map();
  const requests = new Map();
  const streams = new Map();
  const ready = new Set();
  const events = [];
  const record = (kind, fields = {}) => {
    const event = { kind, at: new Date().toISOString(), ...fields };
    events.push(event); onEvent(event);
  };
  function writeStream(message) {
    const stream = streams.get(message.to);
    if (!stream) return;
    stream.write(`data: ${JSON.stringify(message)}\n\n`);
    message.state = 'transport_written';
    record('transport_written', { id: message.id, to: message.to });
  }
  function deliver(message) {
    if (message.to === 'claude') return writeStream(message);
    message.state = 'dispatching';
    Promise.resolve().then(() => deliverCodex(message)).then(() => {
      if (message.state !== 'replied') message.state = 'transport_written';
      record('transport_written', { id: message.id, to: message.to });
    }).catch(error => {
      message.state = 'delivery_unknown';
      record('delivery_unknown', { id: message.id, error: String(error.message) });
    });
  }
  function enqueue(from, to, text, requestId, inReplyTo = null) {
    const key = `${from}:${requestId}`;
    if (requests.has(key)) {
      const existing = messages.get(requests.get(key));
      if (existing.to !== to || existing.text !== text || existing.in_reply_to !== inReplyTo) {
        throw Object.assign(new Error('Request ID reused with different content'), { status: 409 });
      }
      return existing;
    }
    const message = { id: randomUUID(), from, to, text, in_reply_to: inReplyTo, state: 'queued' };
    messages.set(message.id, message); requests.set(key, message.id);
    record('message_accepted', { ...message });
    deliver(message);
    return message;
  }
  const server = createServer(async (req, res) => {
    const principal = Object.keys(tokens).find(name => req.headers.authorization === `Bearer ${tokens[name]}`);
    const respond = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (!principal) return respond(401, { error: 'Invalid connection identity' });
    if (req.method === 'GET' && req.url === '/events' && principal === 'claude') {
      if (streams.has(principal)) return respond(409, { error: 'Session already connected' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': connected\n\n'); streams.set(principal, res);
      record('connected', { member: principal });
      for (const message of messages.values()) if (message.to === principal && message.state === 'queued') writeStream(message);
      res.on('close', () => { if (streams.get(principal) === res) streams.delete(principal); });
      return;
    }
    if (req.method !== 'POST') return respond(404, { error: 'Not found' });
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('Request too large'); }
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
      if (req.url === '/ready') {
        ready.add(principal); record('agent_ready', { member: principal });
        return respond(200, { ready: true });
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8192) throw new Error('Invalid text');
      let message;
      if (req.url === '/send') {
        if (!Object.hasOwn(tokens, body.to) || body.to === principal) throw new Error('Invalid recipient');
        if (typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 100) throw new Error('Invalid request ID');
        message = enqueue(principal, body.to, body.text, body.request_id);
      } else if (req.url === '/reply') {
        const original = messages.get(body.message_id);
        if (!original || original.to !== principal) throw new Error('Message does not belong to this connection');
        message = enqueue(principal, original.from, body.text, `reply:${original.id}`, original.id);
        if (original.state !== 'replied') { original.state = 'replied'; record('agent_replied', { id: original.id, reply_id: message.id }); }
      } else return respond(404, { error: 'Not found' });
      return respond(202, { message_id: message.id, accepted: true });
    } catch (error) { respond(error.status ?? 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    messages, events, ready,
    async close() { for (const stream of streams.values()) stream.end(); server.closeAllConnections(); await new Promise(r => server.close(r)); },
  };
}
