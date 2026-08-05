// Cloudflare Worker: прозрачный CORS-прокси для TON API.
//
// Разблокирует мультикошелек в сетях, где заблокированы toncenter.com / tonapi.io:
// браузер ходит на ваш воркер (workers.dev или свой домен), а воркер сам обращается
// к toncenter/tonapi со своего edge-сервера.
//
// Единственный маршрут: GET {worker}/api/?url=<upstream URL в полном виде>
// Например: /api/?url=https%3A%2F%2Ftoncenter.com%2Fapi%2Fv3%2Faccount%3Faddress%3DUQ...
//
// Как задеплоить (API-токен, без интерактивного логина):
//   1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> шаблон
//      "Edit Cloudflare Workers" -> Create -> скопировать токен
//   2. export CLOUDFLARE_API_TOKEN=<токен>
//   3. cd worker && npm i && npm run deploy
//   4. URL воркера впишите в src/utils/MyNetworkProvider.ts в PROXY_URL
//      либо в браузере: localStorage.setItem('proxy_url', '<URL>')

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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/' && url.pathname !== '/api') {
      return new Response('Not found', { status: 404, headers: CORS });
    }

    const target = url.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing url param' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: 'Bad url param' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (!ALLOWED_HOSTS.has(upstream.host)) {
      return new Response(JSON.stringify({ error: 'Host not allowed: ' + upstream.host }), {
        status: 403,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (upstream.host.includes('toncenter')) {
      headers['X-API-Key'] = TONCENTER_API_KEY;
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream.toString(), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream error: ' + (e && e.message) }), {
        status: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const body = await upstreamResponse.arrayBuffer();
    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
      },
    });
  },
};
