import { WebSocketServer, WebSocket } from 'ws';
import { cardPattern } from './extract.mjs';

// Deliberately loopback-only. This envelope and ACK are a mock gateway protocol,
// not a claim about any enterprise WeChat endpoint's authentication or commands.
export async function localReceiver({ dropFirstAck = false } = {}) {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); });
  const received = new Map(); let frames = 0, dropped = false;
  server.on('connection', socket => socket.on('message', bytes => {
    try {
      const message = JSON.parse(bytes.toString());
      const content = message.body?.text?.content;
      if (message.type !== 'gift_card.notification' || message.body?.msgtype !== 'text' ||
          typeof content !== 'string' || typeof message.idempotencyKey !== 'string' || [...content.matchAll(cardPattern)].length) {
        socket.close(1008,'Invalid protected notification'); return;
      }
      frames++;
      if (!received.has(message.idempotencyKey)) received.set(message.idempotencyKey,message);
      if (dropFirstAck && !dropped) { dropped = true; socket.close(); return; }
      socket.send(JSON.stringify({type:'ack',idempotencyKey:message.idempotencyKey,ok:true}));
    } catch { socket.close(1008,'Invalid notification'); }
  }));
  const url = `ws://127.0.0.1:${server.address().port}`;
  return { url, messages:() => [...received.values()], frameCount:() => frames,
    close:async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); } };
}

export function localTransport(url, { timeoutMs = 1000 } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1') throw Error('Simulation only permits loopback WebSocket destinations');
  return { send:message => new Promise((resolve,reject) => {
    const socket = new WebSocket(url); let settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); socket.close();
      error ? reject(Error('Local notification was not acknowledged')) : resolve();
    };
    const timer = setTimeout(() => { socket.terminate(); finish(true); },timeoutMs);
    socket.once('open', () => socket.send(JSON.stringify(message)));
    socket.on('message', bytes => {
      try { const ack = JSON.parse(bytes.toString()); if (ack.type === 'ack' && ack.ok === true && ack.idempotencyKey === message.idempotencyKey) finish(false); }
      catch { finish(true); }
    });
    socket.once('error', () => finish(true)); socket.once('close', () => finish(true));
  }) };
}
