import { Address } from "@ton/core";

export interface AddressInfo {
  isBounceable: boolean;
  isTestOnly: boolean;
  address: Address;
}

export const base64toHex = (base64: string): string => {
  return Buffer.from(base64, "base64").toString("hex");
};

export const validateUserFriendlyAddress = (
  s: string,
  isTestnet: boolean,
): string | null => {
  if (Address.isFriendly(s)) {
    const address = Address.parseFriendly(s);
    if (address.isTestOnly && !isTestnet) {
      return "Пожалуйста, введите адрес основной сети";
    } else {
      return null;
    }
  } else {
    return "Некорректный адрес";
  }
};

export const explorerUrl = (address: string, isTestnet: boolean) => {
  Address.parseFriendly(address); // check validity
  return (
    (isTestnet ? "https://testnet.tonviewer.com/" : "https://tonviewer.com/") +
    address
  );
};

export const getAddressFormat = async (
  address: Address,
  isTestnet: boolean,
): Promise<AddressInfo> => {
  const raw = address.toRawString();

  // NOTE: It will not work correctly if the address was uninitialized and then became a not-wallet-smart-contact. However, we assume that such situations do not occur in practice. You can manually clear the local storage in this case

  let friendly = localStorage.getItem("address_" + raw);
  if (!friendly) {
    friendly = address.toString({ bounceable: true, testOnly: isTestnet });
    localStorage.setItem("address_" + raw, friendly);
  }

  return Address.parseFriendly(friendly);
};

export const formatAddressAndUrl = async (
  address: Address,
  isTestnet: boolean,
) => {
  const f = await getAddressFormat(address, isTestnet);
  return makeAddressLink(f);
};

export const shortAddress = (addressString: string): string => {
  if (addressString.length <= 20) return addressString;
  return addressString.slice(0, 8) + "..." + addressString.slice(-8);
};

export const makeAddressLink = (address: AddressInfo) => {
  const addressString = addressToString(address);
  const url = explorerUrl(addressString, address.isTestOnly);
  return `<a href="${url}" target="_blank" title="${addressString}">${shortAddress(addressString)}</a>`;
};

export const addressToString = (address: AddressInfo) => {
  return address.address.toString({
    bounceable: address.isBounceable,
    testOnly: address.isTestOnly,
  });
};

export const equalsMsgAddresses = (a: Address | null, b: Address | null) => {
  if (!a) return !b;
  if (!b) return !a;
  return a.equals(b);
};

export const equalsAddressLists = (a: Address[], b: Address[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i].equals(b[i])) return false;
  }
  return true;
};

export const assert = (condition: boolean, error: string) => {
  if (!condition) {
    console.error(error);
    throw new Error(error);
  }
};

const ADDRESS_AVATAR_COLORS = [
  "#e91e63",
  "#9c27b0",
  "#673ab7",
  "#3f51b5",
  "#2196f3",
  "#00bcd4",
  "#009688",
  "#4caf50",
  "#8bc34a",
  "#ff9800",
  "#f44336",
  "#607d8b",
];

const hashString = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
};

const avatarColor = (addressString: string): string =>
  ADDRESS_AVATAR_COLORS[
    hashString(addressString) % ADDRESS_AVATAR_COLORS.length
  ];

// Карточка-аватар адреса: квадрат со скруглёнными углами в цвете адреса,
// внутри — круг того же цвета с акцентным текстом (первые 2 и последние 2
// символа адреса); справа сверху круга — плашка статуса (✅/❌); ниже по
// центру — сокращённый адрес (6 + … + 4 символа). Плашка «Вы» для вашего
// кошелька: при meOnCircle — в правом верхнем углу круга, иначе справа от
// адреса.
export const addressAvatarHTML = (
  address: AddressInfo,
  isMe: boolean,
  statusBadge?: string,
  dnsName?: string,
  meOnCircle = false,
): string => {
  const addressString = addressToString(address);
  const color = avatarColor(addressString);
  const circleText = addressString.slice(0, 2) + "…" + addressString.slice(-2);
  const shortAddr =
    addressString.length > 12
      ? addressString.slice(0, 6) + "…" + addressString.slice(-4)
      : addressString;
  const label = dnsName
    ? dnsName.length > 15
      ? dnsName.slice(0, 7) + "…" + dnsName.slice(-9)
      : dnsName
    : shortAddr;
  const url = explorerUrl(addressString, address.isTestOnly);
  const title = dnsName ? `${dnsName} (${addressString})` : addressString;
  const meOnCircleBadge =
    meOnCircle && isMe ? '<div class="daoAvatarMeBadge">Вы</div>' : "";
  return `
        <a class="daoAvatarCard" href="${url}" target="_blank" title="${title}">
            <div class="daoAvatarTile" style="background:${color}2e">
                <div class="daoAvatarCircleWrap">
                    <div class="daoAvatarCircle" style="background:${color}">${circleText}</div>
                    ${meOnCircleBadge}
                    ${statusBadge ? `<div class="daoAvatarStatusBadge">${statusBadge}</div>` : ""}
                </div>
            </div>
            <div class="daoAvatarMeta">
                <span class="daoAvatarAddress">${label}</span>
                ${isMe && !meOnCircle ? '<span class="daoAvatarMe">Вы</span>' : ""}
            </div>
        </a>`;
};

export const sanitizeHTML = (text: string): string => {
  const d = document.createElement("div");
  d.innerText = text;
  return d.innerHTML;
};
