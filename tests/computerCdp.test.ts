import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { connectCdp } from '../src/browser/cdp.ts';

async function fakeBrowser(t: test.TestContext, answer: (message: { id: number; method: string }) => object | undefined) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const sockets: import('ws').WebSocket[] = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      const reply = answer(message);
      if (reply) socket.send(JSON.stringify({ id: message.id, ...reply }));
    });
  });
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.close(); server.close(() => resolve()); }));
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, sockets };
}

test('requests are matched to their answers, errors keep the method name, events reach listeners', async t => {
  const browser = await fakeBrowser(t, message => message.method === 'Bad.thing' ? { error: { message: 'nope' } } : { result: { echoed: message.method } });
  const cdp = await connectCdp(browser.url);
  t.after(() => cdp.close());
  assert.deepEqual(await cdp.send('Page.enable'), { echoed: 'Page.enable' });
  await assert.rejects(cdp.send('Bad.thing'), /Bad\.thing: nope/);
  const seen = new Promise<string>(resolve => cdp.on(method => resolve(method)));
  browser.sockets[0]!.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.equal(await seen, 'Page.loadEventFired');
});

test('a request the browser never answers times out on its own budget', async t => {
  const browser = await fakeBrowser(t, () => undefined);
  const cdp = await connectCdp(browser.url, { timeoutMs: 30 });
  t.after(() => cdp.close());
  await assert.rejects(cdp.send('Runtime.evaluate'), (error: unknown) => error instanceof Error && error.message === 'Runtime.evaluate: 浏览器没有回应');
});

test('a socket closed with a request in flight rejects that request as a disconnect, and every later send too', async t => {
  // The close below happens only after the server has the request in hand, and this connection's budget is far longer
  // than a close handshake: what the pending promise sees is the disconnect, never a short timeout racing it.
  let seen: (method: string) => void = () => {};
  const received = new Promise<string>(resolve => { seen = resolve; });
  const browser = await fakeBrowser(t, message => { seen(message.method); return undefined; });
  const cdp = await connectCdp(browser.url, { timeoutMs: 5_000 });
  t.after(() => cdp.close());
  const pending = cdp.send('Page.navigate');
  assert.equal(await received, 'Page.navigate');
  browser.sockets[0]!.close();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.message === '浏览器连接已断开');
  assert.equal(cdp.closed, true);
  await assert.rejects(cdp.send('Page.enable'), (error: unknown) => error instanceof Error && error.message === '浏览器连接已断开');
});
