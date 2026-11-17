import { createServer } from 'node:http';
import { postWecom } from '../../src/utils/gift-webhook.js';

const fictionalUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fictional-local-simulation';
export async function localReceiver({dropFirstResponse=false}={}) {
  const received = [];
  const server = createServer(async (request,response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/wecom') { response.writeHead(404).end(); return; }
      let text = '';
      for await (const part of request) {
        text += part;
        if (Buffer.byteLength(text) > 4096) throw Error('local request too large');
      }
      const body = JSON.parse(text);
      if (body.msgtype !== 'text' || typeof body.text?.content !== 'string') throw Error('invalid text message');
      received.push({body});
      // Real group robots have no application idempotency key. Simulating a
      // lost success response must demonstrate the possible duplicate message.
      if (dropFirstResponse && received.length === 1) { response.destroy(); return; }
      response.writeHead(200,{'Content-Type':'application/json'}).end('{"errcode":0,"errmsg":"ok"}');
    } catch { response.writeHead(400).end('{"errcode":400}'); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/wecom`,messages:()=>received,
    frameCount:()=>received.length,close:()=>new Promise(resolve=>server.close(resolve))};
}
export function localTransport(localUrl) {
  const local = new URL(localUrl);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/wecom') throw Error('Loopback receiver required');
  return {send:async message => postWecom(fictionalUrl,message.body,{
    fetcher:(_url,options)=>fetch(localUrl,options),timeoutMs:1500
  })};
}
