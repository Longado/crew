import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import type { TestContext } from 'node:test';

/** Invoke real HTTP handlers with memory streams; no socket, CLI, or model. */
export function memoryWire(t: TestContext) {
  const servers: http.Server[] = [];
  t.mock.method(http.Server.prototype, 'listen', function (this: http.Server, ...args: unknown[]) {
    servers.push(this);
    queueMicrotask(() => { const callback = args.at(-1); if (typeof callback === 'function') callback(); this.emit('listening'); });
    return this;
  });
  t.mock.method(http.Server.prototype, 'address', () => ({ address: '127.0.0.1', family: 'IPv4', port: 19091 }));
  async function invoke(server: http.Server, url: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:19091', 'content-type': 'application/json', ...headers };
    const chunks: string[] = [], responseHeaders: Record<string, unknown> = {};
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } }) as unknown as http.ServerResponse;
    res.statusCode = 200;
    res.writeHead = ((status: number, headers: Record<string, unknown>) => { res.statusCode = status; Object.assign(responseHeaders, headers); return res; }) as http.ServerResponse['writeHead'];
    res.setHeader = (name: string, value: any) => { responseHeaders[name] = value; return res; };
    const finished = new Promise<void>(resolve => res.once('finish', resolve));
    server.emit('request', req, res);
    await new Promise(resolve => setImmediate(resolve));
    if (responseHeaders['content-type'] !== 'text/event-stream') await finished;
    return { res, status: res.statusCode, text: () => chunks.join(''), json: () => JSON.parse(chunks.join('')), headers: responseHeaders };
  }
  return { servers, invoke };
}
