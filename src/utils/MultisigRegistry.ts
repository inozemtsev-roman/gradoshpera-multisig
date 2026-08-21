import { Address, Cell } from "@ton/core";
import { parseMultisigData } from "../multisig/Multisig";
import { getProxyUrl, sendToIndex } from "./MyNetworkProvider";

export interface RegistryJetton {
  name: string;
  address: string;
  decimals?: number;
  logo?: string;
}

export interface RegistryEntry {
  name: string;
  address: string;
  testnet: boolean;
  logo?: string;
  jetton?: RegistryJetton;
}

export interface RegistryFile {
  testnet?: boolean;
  multisigs: Array<Omit<RegistryEntry, "testnet"> & { testnet?: boolean }>;
}

export interface OpenedMultisig {
  address: string;
  lastOpened: number;
}

export type Role = "signer" | "proposer" | "none";

export interface MultisigStatus {
  ok: boolean;
  isMultisig: boolean;
  balance: string;
  role: Role;
  error?: string;
}

const REGISTRY_URL =
  "https://raw.githubusercontent.com/gradosphera/multisig/main/multisigs.json";
const REGISTRY_CACHE_KEY = "daoMultisigsRegistry";
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000;
const OPENED_MULTISIGS_KEY = "openedMultisigs";
const OPENED_MULTISIGS_LIMIT = 50;
const FETCH_TIMEOUT_MS = 8000;

export const STATUS_CONCURRENCY = 6;

const SNAPSHOT: RegistryFile = {
  testnet: false,
  multisigs: [
    {
      name: "ДАО Градосфера",
      address: "EQAbRLmFnI7y5BUmSVvxsz3X4Ejy50uMkgvXPmevthl5K3n9",
      jetton: {
        name: "Благо",
        address: "EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll",
        decimals: 0,
        logo: "https://raw.githubusercontent.com/gradosphera/brand-assets/refs/heads/main/logo.svg",
      },
    },
    {
      name: "Чистая Лига",
      address: "UQACfRYh7GcZJwtB6zI5bn1DO58MXj1GIyY1u94Eg4TJFp8v",
      logo: "https://raw.githubusercontent.com/gradosphera/brand-assets/refs/heads/main/cleanliga/logo.svg",
      jetton: {
        name: "Благо",
        address: "EQBlaryI1HCY6hIlW9giBoqKGtuMHfxlULZOhD6UyzpqLcll",
        decimals: 0,
        logo: "https://raw.githubusercontent.com/gradosphera/brand-assets/refs/heads/main/logo.svg",
      },
    },
  ],
};

const fetchJson = async (url: string, timeoutMs: number): Promise<any> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = await response.json();
    if (!response.ok) throw new Error("HTTP " + response.status);
    return json;
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(
        "Timeout: сервер не отвечает. Проверьте интернет-соединение. Подождите 30 секунд и нажмите кнопку.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
};

const isValidRegistryFile = (json: any): json is RegistryFile =>
  !!json &&
  Array.isArray(json.multisigs) &&
  json.multisigs.every(
    (e: any) =>
      e && typeof e.name === "string" && typeof e.address === "string",
  );

const saveRegistryCache = (file: RegistryFile): void => {
  try {
    localStorage.setItem(
      REGISTRY_CACHE_KEY,
      JSON.stringify({ time: Date.now(), multisigs: file.multisigs }),
    );
  } catch {
    // ignore
  }
};

const loadRegistryCache = (): RegistryFile | null => {
  try {
    const cached = localStorage.getItem(REGISTRY_CACHE_KEY);
    if (!cached) return null;
    const parsed: any = JSON.parse(cached);
    const isFresh =
      parsed &&
      typeof parsed.time === "number" &&
      Date.now() - parsed.time < REGISTRY_CACHE_TTL_MS;
    if (isValidRegistryFile(parsed) && isFresh) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
};

const normalizeEntries = (file: RegistryFile): RegistryEntry[] =>
  file.multisigs.map((e) => ({
    name: e.name,
    address: e.address,
    testnet: e.testnet ?? file.testnet ?? false,
    logo: e.logo,
    jetton: e.jetton,
  }));

// Если в удалённом реестре нет данных о жетоне/логотипе, подтягиваем из
// снапшота. Логотип из снапшота всегда в приоритете — карточки ДАО должны
// показывать заданный в приложении логотип, а не устаревший из реестра.
const enrichJettons = (entries: RegistryEntry[]): RegistryEntry[] => {
  const snapshotJettons = new Map<string, RegistryJetton>();
  const snapshotLogos = new Map<string, string>();
  for (const e of SNAPSHOT.multisigs) {
    if (e.jetton) snapshotJettons.set(rawOf(e.address), e.jetton);
    if (e.logo) snapshotLogos.set(rawOf(e.address), e.logo);
  }
  return entries.map((e) => {
    const raw = rawOf(e.address);
    const jetton = snapshotJettons.get(raw);
    const logo = snapshotLogos.get(raw);
    if (!jetton && !logo) return e;
    return {
      ...e,
      jetton: jetton || e.jetton,
      logo: logo || e.logo,
    };
  });
};

const finalizeEntries = (file: RegistryFile): RegistryEntry[] =>
  enrichJettons(normalizeEntries(file));

// Снапшот-записи реестра — доступны синхронно, без сети (мгновенный показ карточек).
export const getSnapshotEntries = (): RegistryEntry[] =>
  finalizeEntries(SNAPSHOT);

// Реестр мультикошельков ДАО: прямой raw.githubusercontent.com -> прокси -> снапшот.
export const fetchRegistry = async (
  force = false,
): Promise<RegistryEntry[]> => {
  if (!force) {
    const cached = loadRegistryCache();
    if (cached) return finalizeEntries(cached);
  }

  const errors: string[] = [];

  try {
    const json = await fetchJson(REGISTRY_URL, FETCH_TIMEOUT_MS);
    if (!isValidRegistryFile(json)) throw new Error("Invalid format");
    saveRegistryCache(json);
    return finalizeEntries(json);
  } catch (e: any) {
    errors.push("raw: " + (e?.message || e));
  }

  try {
    const proxy = getProxyUrl();
    if (proxy) {
      const json = await fetchJson(
        proxy + "/api/?url=" + encodeURIComponent(REGISTRY_URL),
        FETCH_TIMEOUT_MS,
      );
      if (!isValidRegistryFile(json)) throw new Error("Invalid format");
      saveRegistryCache(json);
      return finalizeEntries(json);
    }
  } catch (e: any) {
    errors.push("proxy: " + (e?.message || e));
  }

  return finalizeEntries(SNAPSHOT);
};

export const getRole = (
  signers: Address[],
  proposers: Address[],
  myAddress: Address | null,
): Role => {
  if (!myAddress) return "none";
  if (signers.some((s) => s.equals(myAddress))) return "signer";
  if (proposers.some((p) => p.equals(myAddress))) return "proposer";
  return "none";
};

// Один вызов 'account' даёт статус, баланс, код и данные.
export const fetchMultisigStatus = async (
  friendlyAddress: string,
  multisigCode: Cell,
  isTestnet: boolean,
  myAddress: Address | null,
): Promise<MultisigStatus> => {
  try {
    const result = await sendToIndex(
      "account",
      { address: friendlyAddress },
      isTestnet,
    );

    if (result.status !== "active") {
      return { ok: true, isMultisig: false, balance: "0", role: "none" };
    }

    let isMultisig = false;
    try {
      isMultisig =
        !!result.code &&
        Cell.fromBase64(result.code).hash().equals(multisigCode.hash());
    } catch {
      isMultisig = false;
    }

    let role: Role = "none";
    if (isMultisig && result.data) {
      try {
        const data = parseMultisigData(Cell.fromBase64(result.data));
        role = getRole(data.signers, data.proposers, myAddress);
      } catch {
        // ignore
      }
    }

    return {
      ok: true,
      isMultisig,
      balance: result.balance != null ? String(result.balance) : "0",
      role,
    };
  } catch (e: any) {
    return {
      ok: false,
      isMultisig: false,
      balance: "",
      role: "none",
      error: e?.message || "Ошибка проверки",
    };
  }
};

// Баланс жетона ДАО на кошельке мультикошелька (в минимальных единицах жетона).
// Пустой/неактивированный кошелёк жетона считается нулевым балансом.
export const fetchJettonBalance = async (
  jettonAddress: string,
  ownerAddress: string,
  isTestnet: boolean,
): Promise<string> => {
  try {
    const jettonRaw =
      Address.parseFriendly(jettonAddress).address.toRawString();
    const ownerRaw = Address.parseFriendly(ownerAddress).address.toRawString();
    const data = await sendToIndex(
      "jettonBalance",
      { account: ownerRaw, jetton: jettonRaw },
      isTestnet,
    );
    return data && data.balance != null ? String(data.balance) : "";
  } catch (e: any) {
    console.warn("fetchJettonBalance failed:", e);
    return "";
  }
};

export const loadOpenedMultisigs = (): OpenedMultisig[] => {
  try {
    const raw = localStorage.getItem(OPENED_MULTISIGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: any) => x && typeof x.address === "string")
      .slice(0, OPENED_MULTISIGS_LIMIT);
  } catch {
    return [];
  }
};

const HIDDEN_MULTISIGS_KEY = "hiddenMultisigs";

// Импортированные кошельки, которые пользователь скрыл с главной страницы
// (например, адрес, не являющийся мультикошельком). Храним raw-адреса.
export const loadHiddenMultisigs = (): Set<string> => {
  try {
    const raw = localStorage.getItem(HIDDEN_MULTISIGS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((x: any) => typeof x === "string").map((x: string) => x),
    );
  } catch {
    return new Set();
  }
};

export const addHiddenMultisig = (friendlyAddress: string): void => {
  try {
    const hidden = loadHiddenMultisigs();
    hidden.add(rawOf(friendlyAddress));
    localStorage.setItem(
      HIDDEN_MULTISIGS_KEY,
      JSON.stringify(Array.from(hidden)),
    );
  } catch {
    // ignore
  }
};

const rawOf = (friendly: string): string => {
  try {
    return Address.parseFriendly(friendly).address.toRawString();
  } catch {
    return friendly;
  }
};

export const addOpenedMultisig = (friendlyAddress: string): void => {
  try {
    const list = loadOpenedMultisigs();
    const rawKey = rawOf(friendlyAddress);
    const filtered = list.filter((x) => rawOf(x.address) !== rawKey);
    filtered.unshift({ address: friendlyAddress, lastOpened: Date.now() });
    localStorage.setItem(
      OPENED_MULTISIGS_KEY,
      JSON.stringify(filtered.slice(0, OPENED_MULTISIGS_LIMIT)),
    );
  } catch {
    // ignore
  }
};

export const mapWithConcurrency = async <T, R>(
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
