# Прокси для разблокировки TON API (Cloudflare Worker)

Мультикошелек читает данные напрямую с `toncenter.com` и `tonapi.io`.
В некоторых сетях эти домены заблокированы (по имени хоста), поэтому страница
показывает «Timeout: все источники данных временно недоступны».

Решение — маленький Cloudflare Worker, который проксирует запросы к toncenter/tonapi
со своего edge-сервера. Браузер ходит на URL воркера, а тот уже обращается к TON API.

## Деплой

### Способ 1 — API-токен (без интерактивного логина)

`wrangler login` здесь не работает (нужен браузерный OAuth). Вместо этого создайте API-токен:

1. Откройте https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → шаблон **Edit Cloudflare Workers** → **Continue** → **Create Token**
3. Скопируйте токен.

Затем задеплойте:

```bash
export CLOUDFLARE_API_TOKEN=<токен>
cd worker
npm i
npm run deploy        # то же, что npx wrangler deploy
```

### Способ 2 — интерактивный логин (на своей машине с браузером)

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler deploy
```

Из вывода возьмите URL вида `https://<ваше-имя>.workers.dev`.

## Подключение к мультикошельку

Двумя способами:

- **Навсегда (в коде):** впишите URL в `src/utils/MyNetworkProvider.ts` в константу
  `PROXY_URL`, затем `npm run build`, скопируйте `dist/*` в `docs/` и запушите.

- **Без пересборки (в браузере):** откройте консоль на странице мультикошелька и
  выполните:

  ```js
  localStorage.setItem('proxy_url', 'https://<ваше-имя>.workers.dev')
  ```

  Затем перезагрузите страницу.

Если прокси задан — он пробуется первым, затем прямые toncenter/tonapi.

## Маршрут

`GET /api/?url=<upstream>` — единственный маршрут. Воркер сам определяет хост
и подставляет API-ключ toncenter серверно (ключ не светится в браузере).
Допускаются только хосты: toncenter.com, testnet.toncenter.com, tonapi.io, testnet.tonapi.io.

> Альтернатива Cloudflare: этот же прокси можно развернуть на Vercel без токенов —
> см. `vercel-proxy/README.md`.
