# Прокси для разблокировки TON API (Vercel)

Мультикошелек читает данные напрямую с `toncenter.com` и `tonapi.io`.
В некоторых сетях эти домены заблокированы (по имени хоста), поэтому страница
показывает «Timeout: все источники данных временно недоступны».

Решение — serverless-функция на Vercel, которая проксирует запросы к toncenter/tonapi
с сервера Vercel. Браузер ходит на URL функции, а она уже обращается к TON API.

## Деплой (2 способа)

### Способ 1 — Vercel Dashboard (проще всего)

1. Откройте https://vercel.com → **Add New Project** → импортируйте этот репозиторий
   (gradoshpera-multisig).
2. В настройках проекта укажите **Root Directory** = `vercel-proxy`.
3. Framework Preset = **Other** (без сборки), Deploy.
4. Получите URL вида `https://<project>.vercel.app`.

### Способ 2 — Vercel CLI

```bash
npm i -g vercel
cd vercel-proxy
vercel --prod
```

## Подключение к мультикошельку

Двумя способами:

- **Навсегда (в коде):** впишите URL в `src/utils/MyNetworkProvider.ts` в константу
  `PROXY_URL`, затем `npm run build`, скопируйте `dist/*` в `docs/` и запушите.

- **Без пересборки (в браузере):** откройте консоль на странице мультикошелька и
  выполните:

  ```js
  localStorage.setItem('proxy_url', 'https://<project>.vercel.app')
  ```

  Затем перезагрузите страницу.

Если прокси задан — он пробуется первым, затем прямые toncenter/tonapi.

## Маршрут

`GET /api/?url=<upstream>` — единственный маршрут. Функция сама определяет хост
и подставляет API-ключ toncenter серверно (ключ не светится в браузере).
Допускаются только хосты: toncenter.com, testnet.toncenter.com, tonapi.io, testnet.tonapi.io.
