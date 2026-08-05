// Cloudflare Worker: прозрачный CORS-прокси для TON API.
//
// Разблокирует мультикошелек в сетях, где заблокированы toncenter.com / tonapi.io:
// браузер ходит на ваш воркер (workers.dev или свой домен), а воркер сам обращается
// к toncenter/tonapi со своего edge-сервера.
//
// Как задеплоить:
//   1. npm i -g wrangler
//   2. cd worker
//   3. wrangler deploy   (нужен аккаунт Cloudflare)
//   4. Прокси-URL из вывода (вида https://multisig-proxy.<ваш-аккаунт>.workers.dev)
//      впишите в src/utils/MyNetworkProvider.ts в константу PROXY_URL,
//      либо задайте в браузере: localStorage.setItem('proxy_url', '<URL>')
//
// Маршруты:
//   /toncenter/<method>?<params>      -> https://toncenter.com/api/v3/<method>?<params>
//   /toncenter-testnet/<method>?<params> -> https://testnet.toncenter.com/api/v3/<method>?<params>
//   /tonapi/<path>                    -> https://tonapi.io/<path>
//   /tonapi-testnet/<path>            -> https://testnet.tonapi.io/<path>

const TONCENTER_API_KEY = 'd843619b379084d133f061606beecbf72ae2bf60e0622e808f2a3f631673599b';

const BASES = {
  toncenter: 'https://toncenter.com/api/v3',
  'toncenter-testnet': 'https://testnet.toncenter.com/api/v3',
  tonapi: 'https://tonapi.io',
  'tonapi-testnet': 'https://testnet.tonapi.io',
};

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
    const path = url.pathname; // e.g. /toncenter/account

    const prefix = path.split('/')[1]; // toncenter | toncenter-testnet | tonapi | tonapi-testnet
    const base = BASES[prefix];
    if (!base) {
      return new Response('Unknown proxy target: ' + prefix, { status: 404, headers: CORS });
    }

    const rest = path.slice(prefix.length + 2); // e.g. account | v2/blockchain/accounts/...
    const upstream = base + '/' + rest + url.search;

    const headers = { 'Content-Type': 'application/json' };
    if (prefix.startsWith('toncenter')) {
      headers['X-API-Key'] = TONCENTER_API_KEY;
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream, { headers });
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
