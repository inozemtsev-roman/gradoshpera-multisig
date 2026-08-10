import { Address } from "@ton/core";
import { sendToIndex } from "./MyNetworkProvider";

// Обратная проверка TON DNS: для кошелька, которому привязан .ton-домен,
// tonapi отдаёт имя в поле name ответа accounts/{id}. Имена кэшируются на час,
// чтобы не создавать лишних запросов при автообновлении раз в 5 секунд.

const DNS_CACHE_TTL_MS = 60 * 60 * 1000;
const DNS_FAILURE_TTL_MS = 60 * 1000;

interface DnsCacheEntry {
  name: string | null;
  time: number;
}

const dnsCache: Map<string, DnsCacheEntry> = new Map();
const dnsInFlight: Map<string, Promise<void>> = new Map();

const cacheKey = (address: Address): string => address.toRawString();

// Синхронное чтение из кэша (используется в рендере).
export const getDnsName = (address: Address): string | null => {
  const hit = dnsCache.get(cacheKey(address));
  if (hit && Date.now() - hit.time < DNS_CACHE_TTL_MS) {
    return hit.name;
  }
  return null;
};

// Дозагрузка DNS-имён только для незакэшированных адресов.
export const fetchDnsNames = async (
  addresses: Address[],
  isTestnet: boolean,
): Promise<void> => {
  const seen = new Set<string>();
  const missing: Address[] = [];
  for (const address of addresses) {
    const key = cacheKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = dnsCache.get(key);
    if (!hit || Date.now() - hit.time >= DNS_CACHE_TTL_MS) {
      missing.push(address);
    }
  }

  const pending = missing.map((address) => {
    const key = cacheKey(address);
    const existing = dnsInFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const friendly = address.toString({
          bounceable: true,
          testOnly: isTestnet,
        });
        const res = await sendToIndex(
          "dnsName",
          { account: friendly },
          isTestnet,
        );
        const name =
          typeof res?.name === "string" && res.name.endsWith(".ton")
            ? res.name
            : null;
        dnsCache.set(key, { name, time: Date.now() });
      } catch (e) {
        console.warn("dnsName fetch failed:", e);
        // При сбое не блокируем показ адреса и повторяем запрос через минуту.
        dnsCache.set(key, {
          name: null,
          time: Date.now() - DNS_CACHE_TTL_MS + DNS_FAILURE_TTL_MS,
        });
      } finally {
        dnsInFlight.delete(key);
      }
    })();

    dnsInFlight.set(key, p);
    return p;
  });

  await Promise.all(pending);
};
