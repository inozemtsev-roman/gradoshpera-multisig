import {
  Address,
  Cell,
  Contract,
  ContractGetMethodResult,
  ContractProvider,
  ContractState,
  OpenedContract,
  Sender,
  SendMode,
  Transaction,
  TupleItem,
  TupleReader,
} from "@ton/core";
import { TonClient } from "@ton/ton";

const API_KEY =
  "d843619b379084d133f061606beecbf72ae2bf60e0622e808f2a3f631673599b";

// Прокси (Cloudflare Worker или Vercel, см. worker/ и vercel-proxy/).
// Пусто = прокси отключён. Также можно задать через localStorage.setItem('proxy_url', 'https://...')
const PROXY_URL = "https://gradoshpera-multisig.vercel.app";

const PROVIDER_TIMEOUT_MS = 5000;
const PROXY_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10000;
const COOLDOWN_MS = 30000;
const TRACE_CONCURRENCY = 10;

type IndexQueryPrimitive = string | number | bigint | boolean;
type IndexQueryValue = IndexQueryPrimitive | IndexQueryPrimitive[];

interface Provider {
  key: string;
  call: (
    method: string,
    params: Record<string, IndexQueryValue>,
    isTestnet: boolean,
  ) => Promise<any>;
}

const getProxyUrl = (): string => {
  try {
    const stored =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("proxy_url")
        : null;
    return (stored || PROXY_URL).replace(/\/+$/, "");
  } catch {
    return PROXY_URL.replace(/\/+$/, "");
  }
};

const isHex = (s: string): boolean =>
  /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;

const hexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

const base64ToHex = (base64: string): string =>
  Buffer.from(base64, "base64").toString("hex");

const hexToBase64IfNeeded = (s?: string | null): string => {
  if (!s) return "";
  if (s.startsWith("te6cckE") || s.startsWith("te6ccvE")) return s;
  if (isHex(s)) return hexToBase64(s);
  return s;
};

const toncenterEndpoint = (isTestnet: boolean) =>
  isTestnet
    ? "https://testnet.toncenter.com/api/v3/"
    : "https://toncenter.com/api/v3/";

const tonapiEndpoint = (isTestnet: boolean) =>
  isTestnet ? "https://testnet.tonapi.io/v2/" : "https://tonapi.io/v2/";

const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<any> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error || "HTTP " + response.status);
    }
    if (json?.error) {
      throw new Error(json.error);
    }
    return json;
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(
        "Timeout: сервер API не отвечает. Проверьте интернет-соединение.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
};

const buildQueryString = (params: Record<string, IndexQueryValue>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, String(item));
      }
    } else {
      query.append(key, String(value));
    }
  }
  return query.toString();
};

// --- Fetchers: прямое обращение или через прокси `{proxy}/api/?url=<upstream>` ---

const TONCENTER_HEADERS = {
  "Content-Type": "application/json",
  "X-API-Key": API_KEY,
};

const fetchToncenterUrl = (url: string): Promise<any> =>
  fetchWithTimeout(
    url,
    { method: "GET", headers: TONCENTER_HEADERS },
    PROVIDER_TIMEOUT_MS,
  );

const fetchTonapiUrl = (url: string): Promise<any> =>
  fetchWithTimeout(url, { method: "GET" }, PROVIDER_TIMEOUT_MS);

const proxyFetch = async (upstreamUrl: string): Promise<any> => {
  const proxy = getProxyUrl();
  return fetchWithTimeout(
    proxy + "/api/?url=" + encodeURIComponent(upstreamUrl),
    {
      method: "GET",
    },
    PROXY_TIMEOUT_MS,
  );
};

const buildToncenterUrl = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
): string =>
  toncenterEndpoint(isTestnet) + method + "?" + buildQueryString(params);

const callToncenterWithFetcher = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
  fetcher: (url: string) => Promise<any>,
): Promise<any> => fetcher(buildToncenterUrl(method, params, isTestnet));

const tonapiMessageToCanonical = (msg: any): any => {
  if (!msg) return null;
  const canonical: any = {};
  if (msg.source)
    canonical.source =
      typeof msg.source === "string" ? msg.source : msg.source.address;
  if (msg.destination)
    canonical.destination =
      typeof msg.destination === "string"
        ? msg.destination
        : msg.destination.address;
  if (msg.bounced != null) canonical.bounced = msg.bounced;
  if (msg.op_code != null) canonical.opcode = msg.op_code;
  if (msg.decoded_op_name != null)
    canonical.decoded_opcode = msg.decoded_op_name;
  const body = hexToBase64IfNeeded(msg.raw_body);
  if (body) canonical.message_content = { body };
  if (msg.init?.boc) canonical.init_state = { body: msg.init.boc };
  return canonical;
};

const tonapiTxToCanonical = (tx: any): any => {
  const hash = hexToBase64IfNeeded(tx?.hash);
  const canonical: any = {
    hash,
    now: tx?.utime,
    utime: tx?.utime,
    in_msg: tonapiMessageToCanonical(tx?.in_msg),
    out_msgs: (tx?.out_msgs || []).map(tonapiMessageToCanonical),
  };
  if (tx?.description) canonical.description = tx.description;
  if (tx?.compute_phase) canonical.compute_ph = tx.compute_phase;
  if (tx?.action_phase) canonical.action_ph = tx.action_phase;
  return canonical;
};

const tonapiTraceToCanonical = (json: any): any => {
  const transactions: Record<string, any> = {};

  const visit = (node: any): void => {
    if (!node || !node.transaction) return;
    const t = node.transaction;
    const hash = hexToBase64IfNeeded(t.hash);
    const success = !!t.success;
    transactions[hash] = {
      hash,
      description: {
        type: "ord",
        bounce: null,
        compute_ph: { skipped: false, success, exit_code: success ? 0 : 1 },
        action: { success },
      },
      in_msg: {
        decoded_opcode: t.in_msg?.decoded_op_name,
        opcode: t.in_msg?.op_code,
        bounced: t.in_msg?.bounced,
      },
    };
    for (const child of node.children || []) {
      visit(child);
    }
  };

  visit(json);

  return { is_incomplete: !!json?.is_incomplete, transactions };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
};

const callTonapiWithFetcher = async (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
  fetcher: (url: string) => Promise<any>,
): Promise<any> => {
  const rpc = tonapiEndpoint(isTestnet);

  switch (method) {
    case "account": {
      const address = encodeURIComponent(String(params.address));
      const json = await fetcher(rpc + "blockchain/accounts/" + address);
      if (json.status === "active" && (!json.code || !json.data)) {
        throw new Error(
          "tonapi: отсутствуют code/data для активного контракта",
        );
      }
      return {
        status: json.status,
        balance: String(json.balance),
        code: json.code,
        data: json.data,
      };
    }
    case "transactions": {
      const address = encodeURIComponent(String(params.account));
      const limit = params.limit != null ? String(params.limit) : "256";
      const json = await fetcher(
        rpc + "blockchain/accounts/" + address + "/transactions?limit=" + limit,
      );
      return {
        transactions: (json.transactions || []).map(tonapiTxToCanonical),
      };
    }
    case "traces": {
      const hashes = Array.isArray(params.tx_hash)
        ? params.tx_hash
        : [params.tx_hash];
      const traces = await mapWithConcurrency(
        hashes,
        TRACE_CONCURRENCY,
        async (hashBase64) => {
          const hex = base64ToHex(String(hashBase64));
          const json = await fetcher(rpc + "traces/" + encodeURIComponent(hex));
          return tonapiTraceToCanonical(json);
        },
      );
      return { traces };
    }
    case "addressBook": {
      const raw = String(params.address);
      const json = await fetcher(rpc + "accounts/" + encodeURIComponent(raw));
      return { [raw]: { user_friendly: json.address } };
    }
    default:
      throw new Error("Не поддерживаемый метод: " + method);
  }
};

const callToncenterDirect = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
): Promise<any> =>
  callToncenterWithFetcher(method, params, isTestnet, fetchToncenterUrl);

const callToncenterViaProxy = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
): Promise<any> =>
  callToncenterWithFetcher(method, params, isTestnet, proxyFetch);

const callTonapiDirect = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
): Promise<any> =>
  callTonapiWithFetcher(method, params, isTestnet, fetchTonapiUrl);

const callTonapiViaProxy = (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
): Promise<any> => callTonapiWithFetcher(method, params, isTestnet, proxyFetch);

const providersForMethod = (method: string): Provider[] => {
  const proxy = getProxyUrl();
  const list: Provider[] = [];

  // Если прокси задан — сначала пробуем его (он разблокирует заблокированную сеть)
  if (proxy) {
    list.push({ key: "proxy-toncenter", call: callToncenterViaProxy });
    list.push({ key: "proxy-tonapi", call: callTonapiViaProxy });
  }

  list.push({ key: "toncenter", call: callToncenterDirect });
  list.push({ key: "tonapi", call: callTonapiDirect });

  return list;
};

const cacheableMethods = new Set(["account", "transactions", "addressBook"]);

const responseCache: Map<string, { time: number; data: any }> = new Map();
const providerCooldown: Map<string, number> = new Map();

export const sendToIndex = async (
  method: string,
  params: Record<string, IndexQueryValue>,
  isTestnet: boolean,
) => {
  const providers = providersForMethod(method);
  if (providers.length === 0) {
    throw new Error("Не поддерживаемый метод: " + method);
  }

  const cacheKey = method + ":" + JSON.stringify(params) + ":" + isTestnet;
  const cacheable = cacheableMethods.has(method);

  if (cacheable) {
    const hit = responseCache.get(cacheKey);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) {
      return hit.data;
    }
  }

  const errors: string[] = [];
  let lastError: any = null;

  for (const provider of providers) {
    const cooldownUntil = providerCooldown.get(provider.key);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      continue;
    }

    try {
      const data = await provider.call(method, params, isTestnet);
      providerCooldown.delete(provider.key);
      if (cacheable) {
        responseCache.set(cacheKey, { time: Date.now(), data });
      }
      return data;
    } catch (e: any) {
      console.warn(`Provider ${provider.key} failed for method ${method}:`, e);
      providerCooldown.set(provider.key, Date.now() + COOLDOWN_MS);
      errors.push(`${provider.key}: ${e?.message || e}`);
      lastError = e;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    "Timeout: все источники данных временно недоступны. Попробуйте позже. (" +
      errors.join("; ") +
      ")",
  );
};

export class MyNetworkProvider implements ContractProvider {
  private contractAddress: Address;
  private isTestnet: boolean;
  private tonClient: TonClient;

  constructor(contractAddress: Address, isTestnet: boolean) {
    this.contractAddress = contractAddress;
    this.isTestnet = isTestnet;
    this.tonClient = new TonClient({
      endpoint: isTestnet
        ? "https://testnet.toncenter.com/api/v2/jsonRPC"
        : "https://toncenter.com/api/v2/jsonRPC",
      apiKey: API_KEY,
      timeout: PROVIDER_TIMEOUT_MS,
    });
  }

  getState(): Promise<ContractState> {
    throw new Error("Method not implemented.");
  }

  async get(name: string, args: TupleItem[]): Promise<ContractGetMethodResult> {
    const errors: string[] = [];

    try {
      return await this.tonClient.runMethod(this.contractAddress, name, args);
    } catch (e: any) {
      errors.push(`toncenter-v2: ${e?.message || e}`);
      console.warn("toncenter v2 get-method failed:", e);
    }

    // Прокси (разблокированная сеть) -> прямой tonapi
    if (getProxyUrl()) {
      try {
        return await this.getFromTonApi(name, args, proxyFetch);
      } catch (e: any) {
        errors.push(`proxy-tonapi: ${e?.message || e}`);
        console.warn("proxy tonapi get-method failed:", e);
      }
    }

    try {
      return await this.getFromTonApi(name, args, fetchTonapiUrl);
    } catch (e: any) {
      errors.push(`tonapi: ${e?.message || e}`);
      console.warn("tonapi get-method failed:", e);
    }

    throw new Error(
      "Timeout: не удалось выполнить get-метод контракта. (" +
        errors.join("; ") +
        ")",
    );
  }

  private async getFromTonApi(
    name: string,
    args: TupleItem[],
    fetcher: (url: string) => Promise<any>,
  ): Promise<ContractGetMethodResult> {
    const address = this.contractAddress.toRawString();
    const url =
      tonapiEndpoint(this.isTestnet) +
      "blockchain/accounts/" +
      encodeURIComponent(address) +
      "/methods/" +
      encodeURIComponent(name);
    const query = new URLSearchParams();
    for (const arg of args) {
      query.append("args", tonApiArgFromCore(arg));
    }

    const json = await fetcher(url + "?" + query.toString());

    const stack = (json.stack || []).map(tonApiStackToCore);
    return {
      stack: new TupleReader(stack),
    };
  }

  external(message: Cell): Promise<void> {
    throw new Error("Method not implemented.");
  }

  internal(
    via: Sender,
    args: {
      value: string | bigint;
      bounce?: boolean;
      sendMode?: SendMode;
      body?: string | Cell;
    },
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }

  open<T extends Contract>(contract: T): OpenedContract<T> {
    throw new Error("Method not implemented.");
  }

  getTransactions(
    address: Address,
    lt: bigint,
    hash: Buffer,
    limit?: number,
  ): Promise<Transaction[]> {
    throw new Error("Method not implemented.");
  }
}

// tonapi GET runGetMethod принимает каждый аргумент как строку TVMStackValue:
// int -> число строкой, cell/slice/builder -> base64 BOC.
const tonApiArgFromCore = (item: TupleItem): string => {
  switch (item.type) {
    case "null":
      return "null";
    case "int":
      return item.value.toString();
    case "cell":
      return item.cell.toBoc().toString("base64");
    case "slice":
      return item.cell.toBoc().toString("base64");
    case "builder":
      return item.cell.toBoc().toString("base64");
    case "tuple":
      return JSON.stringify({
        type: "tuple",
        tuple: item.items.map(tonApiArgFromCore),
      });
    default:
      throw new Error("Неподдерживаемый тип аргумента: " + (item as any).type);
  }
};

const tonApiStackToCore = (item: any): TupleItem => {
  switch (item?.type) {
    case "null":
      return { type: "null" };
    case "int":
      return { type: "int", value: BigInt(item.num) };
    case "cell":
      return { type: "cell", cell: Cell.fromBase64(item.cell) };
    case "slice":
      return { type: "slice", cell: Cell.fromBase64(item.slice) };
    case "builder":
      return {
        type: "builder",
        cell: Cell.fromBase64(item.cell || item.builder),
      };
    case "tuple":
      return {
        type: "tuple",
        items: (item.tuple || []).map(tonApiStackToCore),
      };
    default:
      throw new Error("Неподдерживаемый тип элемента стека: " + item?.type);
  }
};
