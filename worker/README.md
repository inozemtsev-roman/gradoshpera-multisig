# Прокси для разблокировки TON API (Cloudflare Worker)

Мультикошелек читает данные напрямую с `toncenter.com` и `tonapi.io`.
В некоторых сетях эти домены заблокированы (по имени хоста), поэтому страница
показывает «Timeout: все источники данных временно недоступны».

Решение — маленький Cloudflare Worker, который проксирует запросы к toncenter/tonapi
со своего edge-сервера. Браузер ходит на URL воркера, а тот уже обращается к TON API.

## Деплой

1. Установите wrangler:

   ```bash
   npm i -g wrangler
   ```

2. Войдите в аккаунт Cloudflare:

   ```bash
   wrangler login
   ```

3. Задеплойте:

   ```bash
   cd worker
   wrangler deploy
   ```

4. Из вывода возьмите URL вида `https://<ваше-имя>.workers.dev`.

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

## Маршруты

| Путь воркера                      | Куда идёт                              |
|-----------------------------------|----------------------------------------|
| `/toncenter/<метод>?<params>`     | `toncenter.com/api/v3/<метод>?<params>` |
| `/toncenter-testnet/<метод>?<params>` | `testnet.toncenter.com/api/v3/...`  |
| `/tonapi/<путь>`                  | `tonapi.io/<путь>`                     |
| `/tonapi-testnet/<путь>`          | `testnet.tonapi.io/<путь>`              |

API-ключ toncenter зашит в воркер и подставляется серверно, ключ не светится в браузере.
