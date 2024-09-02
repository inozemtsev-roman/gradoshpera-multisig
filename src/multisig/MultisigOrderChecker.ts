import {
  AddressInfo,
  addressToString,
  assert,
  equalsAddressLists,
  formatAddressAndUrl,
  getAddressFormat,
  sanitizeHTML,
} from "../utils/utils";
import {
  Address,
  Cell,
  Dictionary,
  fromNano,
  loadMessageRelaxed,
} from "@ton/core";
import { cellToArray, endParse } from "./Multisig";
import { Order, parseOrderData } from "./Order";
import { MultisigInfo } from "./MultisigChecker";
import { MyNetworkProvider, sendToIndex } from "../utils/MyNetworkProvider";
import {
  intToLockType,
  JettonMinter,
  lockTypeToDescription,
} from "../jetton/JettonMinter";
import { CommonMessageInfoRelaxedInternal } from "@ton/core/src/types/CommonMessageInfoRelaxed";

export interface MultisigOrderInfo {
  address: AddressInfo;
  tonBalance: bigint;
  orderId: bigint;
  isExecuted: boolean;
  approvalsNum: number;
  approvalsMask: number;
  threshold: number;
  signers: AddressInfo[];
  expiresAt: Date;
  actions: string[];
  stateInitMatches: boolean;
}

const checkNumber = (n: number) => {
  if (n === null) throw new Error("Invalid number");
  if (n === undefined) throw new Error("Invalid number");
  if (isNaN(n)) throw new Error("Invalid number");
  if (n < 0) throw new Error("Invalid number");
};

export const checkMultisigOrder = async (
  multisigOrderAddress: AddressInfo,
  multisigOrderCode: Cell,
  multisigInfo: MultisigInfo,
  isTestnet: boolean,
  needAdditionalChecks: boolean
): Promise<MultisigOrderInfo> => {
  // Account State and Data

  const result = await sendToIndex(
    "account",
    { address: addressToString(multisigOrderAddress) },
    isTestnet
  );
  assert(
    result.status === "active",
    "Контракт не активен. Если вы только что создали заявку, она должна появиться в течение ~30 секунд."
  );

  assert(
    Cell.fromBase64(result.code).equals(multisigOrderCode),
    "Код контракта НЕ совпадает с кодом мультикошелька заявки из этого хранилища"
  );

  const tonBalance = result.balance;

  const data = Cell.fromBase64(result.data);
  const parsedData = parseOrderData(data);

  checkNumber(parsedData.threshold);
  assert(parsedData.threshold > 0, "Число подтверждающих не больше нуля");
  assert(
    parsedData.threshold <= parsedData.signers.length,
    "Недопустимый порог"
  );
  checkNumber(parsedData.approvalsMask);
  checkNumber(parsedData.approvalsNum);
  assert(
    parsedData.approvalsNum <= parsedData.signers.length,
    "Неправильное количество"
  );
  checkNumber(parsedData.expirationDate);

  const signersFormatted = [];
  for (const signer of parsedData.signers) {
    signersFormatted.push(await getAddressFormat(signer, isTestnet));
  }

  // Check in multisig

  assert(
    parsedData.multisigAddress.equals(multisigInfo.address.address),
    "Адрес мультикошелька не найден"
  );

  const multisigOrderToCheck = Order.createFromConfig(
    {
      multisig: multisigInfo.address.address,
      orderSeqno: parsedData.orderSeqno,
    },
    multisigOrderCode
  );

  assert(
    multisigOrderToCheck.address.equals(multisigOrderAddress.address),
    "Неправильный адрес заявки"
  );

  if (!parsedData.isExecuted) {
    assert(
      multisigInfo.threshold <= parsedData.threshold,
      "Количество подтверждающих не соответствует порогу заявки"
    );
    assert(
      equalsAddressLists(
        multisigInfo.signers.map((a) => a.address),
        parsedData.signers
      ),
      "Количество подтверждающих не совпадает с количествои в заявке"
    );
  }

  if (needAdditionalChecks) {
    // Get-methods

    const provider = new MyNetworkProvider(
      multisigOrderAddress.address,
      isTestnet
    );
    const multisigOrderContract: Order = Order.createFromAddress(
      multisigOrderAddress.address
    );
    const getData = await multisigOrderContract.getOrderDataStrict(provider);

    assert(
      getData.multisig.equals(parsedData.multisigAddress),
      "Invalid multisigAddress"
    );
    assert(getData.order_seqno === parsedData.orderSeqno, "Invalid orderSeqno");
    assert(getData.threshold === parsedData.threshold, "Invalid threshold");
    assert(getData.executed === parsedData.isExecuted, "Invalid isExecuted");
    assert(
      equalsAddressLists(getData.signers, parsedData.signers),
      "Invalid signers"
    );
    assert(
      getData._approvals === BigInt(parsedData.approvalsMask),
      "Invalid approvalsMask"
    );
    assert(
      getData.approvals_num === parsedData.approvalsNum,
      "Invalid approvalsNum"
    );
    assert(
      getData.expiration_date === BigInt(parsedData.expirationDate),
      "Invalid expirationDate"
    );
    assert(
      getData.order.hash().equals(parsedData.order.hash()),
      "Invalid order"
    );
  }

  // StateInit

  const multisigOrderAddress3 = Order.createFromConfig(
    {
      multisig: parsedData.multisigAddress,
      orderSeqno: parsedData.orderSeqno,
    },
    multisigOrderCode
  );

  const stateInitMatches = multisigOrderAddress3.address.equals(
    multisigOrderAddress.address
  );

  // Actions

  const actions = Dictionary.loadDirect(
    Dictionary.Keys.Uint(8),
    Dictionary.Values.Cell(),
    parsedData.order
  );

  const parseActionBody = async (cell: Cell): Promise<string> => {
    try {
      const slice = cell.beginParse();
      if (slice.remainingBits === 0 && slice.remainingRefs == 0) {
        return "Отправьте TON с помощью мультикошелька без комментария";
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const op = slice.loadUint(32);
      if (op == 0) {
        const text = slice.loadStringTail();
        return `Отправьте TON с помощью мультикошелька с комментарием "${sanitizeHTML(
          text
        )}"`;
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseMintMessage(slice);
      assert(
        parsed.internalMessage.forwardPayload.remainingBits === 0 &&
          parsed.internalMessage.forwardPayload.remainingRefs === 0,
        "Полезная нагрузка не поддерживается"
      );
      const toAddress = await formatAddressAndUrl(parsed.toAddress, isTestnet);
      return `Выпустить ${
        parsed.internalMessage.jettonAmount
      } жетонов (в единицах измерения) на адрес ${toAddress}; ${fromNano(
        parsed.tonAmount
      )} TON для оплаты газа`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseTopUp(slice);
      return `Пополнить`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseChangeAdmin(slice);
      const newAdminAddress = await formatAddressAndUrl(
        parsed.newAdminAddress,
        isTestnet
      );
      return `Сменить адрес администратора на ${newAdminAddress}`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseClaimAdmin(slice);
      return `Запросить адрес администратора`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseChangeContent(slice);
      return `Сменить метаданные на "${sanitizeHTML(parsed.newMetadataUrl)}"`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseTransfer(slice);
      if (parsed.customPayload)
        throw new Error("Отправка состояния не поддерживается");
      assert(
        parsed.forwardPayload.remainingBits === 0 &&
          parsed.forwardPayload.remainingRefs === 0,
        "Отправка не поддерживается"
      );
      const toAddress = await formatAddressAndUrl(parsed.toAddress, isTestnet);
      return `Отправить ${parsed.jettonAmount} жетонов с адреса мультикошелька на адрес пользователя ${toAddress};`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(
        slice,
        JettonMinter.parseSetStatus
      );
      const userAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet
      );
      const lockType = intToLockType(parsed.action.newStatus);
      return `Блокировать жетоны пользователя ${userAddress}. Смена состояния "${lockType}" - "${lockTypeToDescription(
        lockType
      )}"; ${fromNano(parsed.tonAmount)} TON для оплаты газа`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(
        slice,
        JettonMinter.parseTransfer
      );
      if (parsed.action.customPayload)
        throw new Error("Принудительная отправка не поддерживается");
      assert(
        parsed.action.forwardPayload.remainingBits === 0 &&
          parsed.action.forwardPayload.remainingRefs === 0,
        "Принудительная отправка не поддерживается"
      );
      const fromAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet
      );
      const toAddress = await formatAddressAndUrl(
        parsed.action.toAddress,
        isTestnet
      );
      return `Принудительная отправка ${
        parsed.action.jettonAmount
      } с адреса пользователя ${fromAddress} на адрес ${toAddress}; ${fromNano(
        parsed.tonAmount
      )} TON для оплаты комиссии`;
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(slice, JettonMinter.parseBurn);
      if (parsed.action.customPayload)
        throw new Error("Сжигание не поддерживается");
      const userAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet
      );
      return `Принудительное сжигание ${
        parsed.action.jettonAmount
      } жетонов с адреса пользователя ${userAddress}; ${fromNano(
        parsed.tonAmount
      )} TON для оплаты комиссии`;
    } catch (e) {}

    throw new Error("Неподдерживаемое действие");
  };

  let parsedActions: string[] = [];

  const actionsKeys = actions.keys();
  for (let key of actionsKeys) {
    let actionString = `<div class="label">Действие №${key}:</div>`;

    const action = actions.get(key);
    const slice = action!.beginParse();
    const actionOp = slice.loadUint(32);
    if (actionOp === 0xf1381e5b) {
      // send message
      const sendMode = slice.loadUint(8);

      let sendModeString = [];
      let allBalance = false;

      if (sendMode & 1) {
        sendModeString.push("Комиссия оплачиваются отдельно");
      }
      if (sendMode & 2) {
        sendModeString.push("Игнорировать ошибки");
      }
      if (sendMode & 128) {
        allBalance = true;
        sendModeString.push("ПЕРЕНЕСТИ ВЕСЬ БАЛАНС");
      }
      if (sendMode & 64) {
        sendModeString.push("Перенести весь остаток входящего сообщения");
      }
      if (sendMode & 32) {
        sendModeString.push("УНИЧТОЖИТЬ АККАУНТ");
      }

      const actionBody = slice.loadRef();
      endParse(slice);
      const messageRelaxed = loadMessageRelaxed(actionBody.beginParse());
      console.log(messageRelaxed);

      const info: CommonMessageInfoRelaxedInternal = messageRelaxed.info as any;

      const destAddress = await formatAddressAndUrl(info.dest, isTestnet);
      actionString += `<div>Отправить ${
        allBalance ? "ВЕСЬ БАЛАНС" : fromNano(info.value.coins)
      } TON на адрес ${destAddress}</div>`;
      actionString += `<div>${await parseActionBody(
        messageRelaxed.body
      )}</div>`;
      if (sendMode) {
        actionString += `<div>Метод отправки: ${sendModeString.join(
          ", "
        )}.</div>`;
      }
    } else if (actionOp === 0x1d0cfbd3) {
      // update_multisig_params
      const newThreshold = slice.loadUint(8);
      const newSigners = cellToArray(slice.loadRef());
      const newProposers = slice.loadUint(1)
        ? cellToArray(slice.loadRef())
        : [];
      endParse(slice);

      assert(newSigners.length > 0, "Неправильный кошелек подписывающего");
      assert(newThreshold > 0, "Неверное значение порога голосования");
      assert(newThreshold <= newSigners.length, "Неверный порог");

      actionString += `<div>Обновить параметры мультикошелька</div>`;
      actionString += `<div>Новый порог подписей : ${newThreshold.toString()}</div>`;

      actionString += "<div>Новые подтверждающие:</div>";
      for (let i = 0; i < newSigners.length; i++) {
        const signer = newSigners[i];
        const addressString = await formatAddressAndUrl(signer, isTestnet);
        actionString += `<div>#${i + 1} - ${addressString}</div>`;
      }

      actionString += "<div>Новые предлагающие:</div>";
      if (newProposers.length > 0) {
        for (let i = 0; i < newProposers.length; i++) {
          const proposer = newProposers[i];
          const addressString = await formatAddressAndUrl(proposer, isTestnet);
          actionString += `<div>#${i + 1} - ${addressString}</div>`;
        }
      } else {
        actionString += "<div>Нет предлагающих</div>";
      }
    } else {
      throw new Error("Неправильное действие");
    }

    parsedActions.push(actionString);
  }

  return {
    address: multisigOrderAddress,
    tonBalance,
    orderId: parsedData.orderSeqno,
    isExecuted: parsedData.isExecuted,
    approvalsNum: parsedData.approvalsNum,
    approvalsMask: parsedData.approvalsMask,
    threshold: parsedData.threshold,
    signers: signersFormatted,
    expiresAt: new Date(parsedData.expirationDate * 1000),
    actions: parsedActions,
    stateInitMatches,
  };
};
