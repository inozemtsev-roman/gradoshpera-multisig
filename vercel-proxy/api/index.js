// Vercel serverless function: прозрачный CORS-прокси для TON API.
//
// Маршрут: GET {vercel}/api/?url=<upstream URL в полном виде>
// Например: /api/?url=https%3A%2F%2Ftoncenter.com%2Fapi%2Fv3%2Faccount%3Faddress%3DUQ...
//
// Файл называется index.js, поэтому обслуживается по адресу /api и /api/.
// Внимание: используем только нативные методы Node http (writeHead/end) —
// Vercel-хелперы res.set() не существует.

const TONCENTER_API_KEY = 'd843619b379084d133f061606beecbf72ae2bf60e0622e808f2a3f631673599b';

const ALLOWED_HOSTS = new Set([
  'toncenter.com',
  'testnet.toncenter.com',
  'tonapi.io',
  'testnet.tonapi.io',
  'raw.githubusercontent.com',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    send(res, 405, JSON_HEADERS, JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const target = req.query && req.query.url;
  if (!target) {
    send(res, 400, JSON_HEADERS, JSON.stringify({ error: 'Missing url param' }));
    return;
  }

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    send(res, 400, JSON_HEADERS, JSON.stringify({ error: 'Bad url param' }));
    return;
  }

  if (!ALLOWED_HOSTS.has(upstream.host)) {
    send(res, 403, JSON_HEADERS, JSON.stringify({ error: 'Host not allowed: ' + upstream.host }));
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (upstream.host.includes('toncenter')) {
    headers['X-API-Key'] = TONCENTER_API_KEY;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstream.toString(), { headers });
  } catch (e) {
    send(res, 502, JSON_HEADERS, JSON.stringify({ error: 'Upstream error: ' + (e && e.message) }));
    return;
  }

  const body = await upstreamResponse.text();
  send(res, upstreamResponse.status, JSON_HEADERS, body);
};
