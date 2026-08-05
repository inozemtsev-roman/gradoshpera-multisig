// Vercel serverless function: прозрачный CORS-прокси для TON API.
//
// Маршрут: GET {vercel}/api/?url=<upstream URL в полном виде>
// Например: /api/?url=https%3A%2F%2Ftoncenter.com%2Fapi%2Fv3%2Faccount%3Faddress%3DUQ...
//
// Файл называется index.js, поэтому обслуживается по адресу /api и /api/.

const TONCENTER_API_KEY = 'd843619b379084d133f061606beecbf72ae2bf60e0622e808f2a3f631673599b';

const ALLOWED_HOSTS = new Set([
  'toncenter.com',
  'testnet.toncenter.com',
  'tonapi.io',
  'testnet.tonapi.io',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).set(CORS).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).set(CORS).json({ error: 'Method not allowed' });
    return;
  }

  const target = req.query.url;
  if (!target) {
    res.status(400).set(CORS).json({ error: 'Missing url param' });
    return;
  }

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    res.status(400).set(CORS).json({ error: 'Bad url param' });
    return;
  }

  if (!ALLOWED_HOSTS.has(upstream.host)) {
    res.status(403).set(CORS).json({ error: 'Host not allowed: ' + upstream.host });
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
    res.status(502).set(CORS).json({ error: 'Upstream error: ' + (e && e.message) });
    return;
  }

  const body = await upstreamResponse.text();
  res
    .status(upstreamResponse.status)
    .set({ ...CORS, 'Content-Type': 'application/json' })
    .send(body);
};
