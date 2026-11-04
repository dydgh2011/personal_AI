// Entry point in front of Next's standalone server.js.
//
// Next keeps a client-supplied X-Forwarded-For (`x-forwarded-for ??= socket.remoteAddress`), so any
// client could pick the address the login limiter sees. Here every request's client address is
// taken from the TCP peer; forwarded headers are honoured only when the peer is one of
// DASHBOARD_TRUSTED_PROXIES (e.g. a Tailscale / reverse proxy in front), and then only the entry
// that proxy appended (the rightmost). The result is passed on as X-PAI-Client-IP.
'use strict';
const http = require('node:http');

const trusted = new Set(
  (process.env.DASHBOARD_TRUSTED_PROXIES || '')
    .split(',')
    .map((s) => normalize(s.trim()))
    .filter(Boolean),
);
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded'];

function normalize(address) {
  return typeof address === 'string' ? address.replace(/^::ffff:/, '') : '';
}

function sanitize(req) {
  const peer = normalize(req.socket && req.socket.remoteAddress) || 'unknown';
  const headers = req.headers;
  let client = peer;
  if (trusted.has(peer)) {
    const chain = String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) client = normalize(chain[chain.length - 1]);
  } else {
    for (const name of FORWARDED) delete headers[name];
  }
  headers['x-pai-client-ip'] = client;
}

const createServer = http.createServer;
http.createServer = function patchedCreateServer(...args) {
  const index = args.findIndex((a) => typeof a === 'function');
  if (index >= 0) {
    const listener = args[index];
    args[index] = function sanitizedListener(req, res) {
      sanitize(req);
      return listener.call(this, req, res);
    };
  }
  return createServer.apply(this, args);
};

module.exports = { sanitize };
if (require.main === module) require('./server.js');
