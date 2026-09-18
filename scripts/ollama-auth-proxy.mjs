#!/usr/bin/env node
// ollama-auth-proxy.mjs - Minimal reverse proxy that requires a Bearer token
// before forwarding to Ollama. Sits between cloudflared and Ollama so the
// public tunnel URL cannot be used to run the model without the shared secret.
//
// Env:
//   OLLAMA_AUTH_TOKEN  required shared secret
//   OLLAMA_UPSTREAM    default http://127.0.0.1:11434
//   OLLAMA_PROXY_HOST  default 127.0.0.1
//   OLLAMA_PROXY_PORT  default 11435
import http from 'node:http';
import crypto from 'node:crypto';

const UPSTREAM = process.env.OLLAMA_UPSTREAM || 'http://127.0.0.1:11434';
const HOST = process.env.OLLAMA_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.OLLAMA_PROXY_PORT || 11435);
const TOKEN = process.env.OLLAMA_AUTH_TOKEN || '';

if (!TOKEN) {
  console.error('OLLAMA_AUTH_TOKEN is required');
  process.exit(1);
}

const upstream = new URL(UPSTREAM);

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? timingSafeEqual(match[1].trim(), TOKEN) : false;
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const headers = { ...req.headers, host: upstream.host };

  const proxyReq = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Bad gateway' }));
  });

  req.on('aborted', () => proxyReq.destroy());
  res.on('close', () => proxyReq.destroy());

  req.pipe(proxyReq);
});

// Long local generations can take minutes (cold model loads alone reached 170s,
// and streaming caps allow up to 300s+). Node's default request/header timeouts
// kill the socket at those durations, which surfaces as "socket hang up" and a
// truncated reply. Disable them so the stream lives as long as Ollama needs.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`Ollama auth proxy listening on http://${HOST}:${PORT} -> ${UPSTREAM}`);
});
