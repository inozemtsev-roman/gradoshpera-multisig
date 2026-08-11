import {
  AddressInfo,
  addressAvatarHTML,
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
  CommonMessageInfoRelaxedInternal,
} from "@ton/core";
import { cellToArray, endParse } from "./Multisig";
import { Order, parseOrderData } from "./Order";
import { MultisigInfo } from "./MultisigChecker";
import {
  MyNetworkProvider,
  parseCellFromStateString,
  sendToIndex,
} from "../utils/MyNetworkProvider";
import { fetchDnsNames, getDnsName } from "../utils/Dns";
import {
  intToLockType,
  JettonMinter,
  lockTypeToDescription,
} from "../jetton/JettonMinter";
import {
  SINGLE_NOMINATOR_POOL_OP_CHANGE_VALIDATOR_ADDRESS,
  SINGLE_NOMINATOR_POOL_OP_WITHDRAW,
  VESTING_INTERNAL_TRANSFER,
} from "./Constants";

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
  summary?: {
    gram: string;
    jetton?: {
      amount: string;
      kind: "mint" | "transfer";
    };
  };
  stateInitMatches: boolean;
  isMismatchSigners: boolean;
  isMismatchThreshold: boolean;
}

const checkNumber = (n: number) => {
  if (n === null) throw new Error("Некорректное число");
  if (n === undefined) throw new Error("Некорректное число");
  if (isNaN(n)) throw new Error("Некорректное число");
  if (n < 0) throw new Error("Некорректное число");
};

export const checkMultisigOrder = async (
  multisigOrderAddress: AddressInfo,
  multisigOrderCode: Cell,
  multisigInfo: MultisigInfo,
  isTestnet: boolean,
  needAdditionalGetMethodChecks: boolean,
): Promise<MultisigOrderInfo> => {
  // Account State and Data

  const result = await sendToIndex(
    "account",
    { address: addressToString(multisigOrderAddress) },
    isTestnet,
  );
  assert(
    result.status === "active",
    "Контракт не активен. Если вы только что создали заявку, она должна появиться в течение ~30 секунд.",
  );

  assert(
    parseCellFromStateString(result.code, "code").equals(multisigOrderCode),
    "Код контракта НЕ совпадает с кодом заявки мультикошелька из этого репозитория",
  );

  const tonBalance = result.balance;

  const data = parseCellFromStateString(result.data, "data");
  const parsedData = parseOrderData(data);

  checkNumber(parsedData.threshold);
  assert(parsedData.threshold > 0, "Threshold not positive");
  assert(
    parsedData.threshold <= parsedData.signers.length,
    "Invalid threshold",
  );
  checkNumber(parsedData.approvalsMask);
  checkNumber(parsedData.approvalsNum);
  assert(
    parsedData.approvalsNum <= parsedData.signers.length,
    "Invalid approvalsNum ",
  );
  checkNumber(parsedData.expirationDate);

  const signersFormatted = [];
  for (const signer of parsedData.signers) {
    signersFormatted.push(await getAddressFormat(signer, isTestnet));
  }

  // Check in multisig

  assert(
    parsedData.multisigAddress.equals(multisigInfo.address.address),
    "Адрес мультикошелька не совпадает",
  );

  const multisigOrderToCheck = Order.createFromConfig(
    {
      multisig: multisigInfo.address.address,
      orderSeqno: parsedData.orderSeqno,
    },
    multisigOrderCode,
  );

  assert(
    multisigOrderToCheck.address.equals(multisigOrderAddress.address),
    "Поддельный заявка мультикошелька",
  );

  let isMismatchSigners = false;
  let isMismatchThreshold = false;

  if (!parsedData.isExecuted) {
    isMismatchThreshold = multisigInfo.threshold > parsedData.threshold;
    isMismatchSigners = !equalsAddressLists(
      multisigInfo.signers.map((a) => a.address),
      parsedData.signers,
    );
  }

  if (needAdditionalGetMethodChecks) {
    // Get-methods

    const provider = new MyNetworkProvider(
      multisigOrderAddress.address,
      isTestnet,
    );
    const multisigOrderContract: Order = Order.createFromAddress(
      multisigOrderAddress.address,
    );
    const getData = await multisigOrderContract.getOrderDataStrict(provider);

    assert(
      getData.multisig.equals(parsedData.multisigAddress),
      "Invalid multisigAddress",
    );
    assert(getData.order_seqno === parsedData.orderSeqno, "Invalid orderSeqno");
    assert(getData.threshold === parsedData.threshold, "Invalid threshold");
    assert(getData.executed === parsedData.isExecuted, "Invalid isExecuted");
    assert(
      equalsAddressLists(getData.signers, parsedData.signers),
      "Invalid signers",
    );
    assert(
      getData._approvals === BigInt(parsedData.approvalsMask),
      "Invalid approvalsMask",
    );
    assert(
      getData.approvals_num === parsedData.approvalsNum,
      "Invalid approvalsNum",
    );
    assert(
      getData.expiration_date === BigInt(parsedData.expirationDate),
      "Invalid expirationDate",
    );
    assert(
      getData.order.hash().equals(parsedData.order.hash()),
      "Invalid order",
    );
  }

  // StateInit

  const multisigOrderAddress3 = Order.createFromConfig(
    {
      multisig: parsedData.multisigAddress,
      orderSeqno: parsedData.orderSeqno,
    },
    multisigOrderCode,
  );

  const stateInitMatches = multisigOrderAddress3.address.equals(
    multisigOrderAddress.address,
  );

  // Actions

  const actions = Dictionary.loadDirect(
    Dictionary.Keys.Uint(8),
    Dictionary.Values.Cell(),
    parsedData.order,
  );

  const parseActionBody = async (
    cell: Cell,
  ): Promise<{
    text: string;
    jetton?: { amount: string; kind: "mint" | "transfer" };
  }> => {
    try {
      const slice = cell.beginParse();
      if (slice.remainingBits === 0 && slice.remainingRefs == 0) {
        return { text: "Отправить GRAM с мультикошелька без комментария" };
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const op = slice.loadUint(32);
      if (op == 0) {
        const text = slice.loadStringTail();
        return {
          text: `Отправить GRAM с мультикошелька с комментарием "${sanitizeHTML(text)}"`,
        };
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseMintMessage(slice);
      assert(
        parsed.internalMessage.forwardPayload.remainingBits === 0 &&
          parsed.internalMessage.forwardPayload.remainingRefs === 0,
        "Mint forward payload not supported",
      );
      const toAddress = await formatAddressAndUrl(parsed.toAddress, isTestnet);
      return {
        text: `Минт ${parsed.internalMessage.jettonAmount} жетонов (в единицах) на ${toAddress}; ${fromNano(parsed.tonAmount)} GRAM на газ`,
        jetton: {
          amount: parsed.internalMessage.jettonAmount.toString(),
          kind: "mint",
        },
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseTopUp(slice);
      return { text: `Пополнение` };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseChangeAdmin(slice);
      const newAdminAddress = await formatAddressAndUrl(
        parsed.newAdminAddress,
        isTestnet,
      );
      return { text: `Сменить администратора на ${newAdminAddress}` };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseClaimAdmin(slice);
      return { text: `Принять управление` };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseChangeContent(slice);
      return {
        text: `Изменить URL метаданных на "${sanitizeHTML(parsed.newMetadataUrl)}"`,
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseTransfer(slice);
      if (parsed.customPayload)
        throw new Error("Transfer custom payload not supported");

      let comment = "";
      if (
        parsed.forwardPayload.remainingBits === 0 &&
        parsed.forwardPayload.remainingRefs === 0
      ) {
        comment = "без комментария";
      } else if (parsed.forwardPayload.remainingBits >= 32) {
        const op = parsed.forwardPayload.loadUint(32);
        assert(op === 0, "Transfer arbitrary forward payload not supported");
        comment =
          'с комментарием "' +
          sanitizeHTML(parsed.forwardPayload.loadStringTail()) +
          '"';
      } else {
        assert(false, "Transfer arbitrary forward payload not supported");
      }

      const toAddress = await formatAddressAndUrl(parsed.toAddress, isTestnet);
      return {
        text: `Перевод ${parsed.jettonAmount} жетонов (в единицах) с мультикошелька пользователю ${toAddress} ${comment};`,
        jetton: {
          amount: parsed.jettonAmount.toString(),
          kind: "transfer",
        },
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(
        slice,
        JettonMinter.parseSetStatus,
      );
      const userAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet,
      );
      const lockType = intToLockType(parsed.action.newStatus);
      return {
        text: `Блокировка кошелька жетонов пользователя ${userAddress}. Установить статус "${lockType}" - "${lockTypeToDescription(lockType)}"; ${fromNano(parsed.tonAmount)} GRAM на газ`,
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(
        slice,
        JettonMinter.parseTransfer,
      );
      if (parsed.action.customPayload)
        throw new Error("Force transfer custom payload not supported");
      assert(
        parsed.action.forwardPayload.remainingBits === 0 &&
          parsed.action.forwardPayload.remainingRefs === 0,
        "Force transfer forward payload not supported",
      );
      const fromAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet,
      );
      const toAddress = await formatAddressAndUrl(
        parsed.action.toAddress,
        isTestnet,
      );
      return {
        text: `Принудительный перевод ${parsed.action.jettonAmount} жетонов (в единицах) от пользователя ${fromAddress} к ${toAddress}; ${fromNano(parsed.tonAmount)} GRAM за газ`,
        jetton: {
          amount: parsed.action.jettonAmount.toString(),
          kind: "transfer",
        },
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const parsed = JettonMinter.parseCallTo(slice, JettonMinter.parseBurn);
      if (parsed.action.customPayload)
        throw new Error("Burn custom payload not supported");
      const userAddress = await formatAddressAndUrl(
        parsed.toAddress,
        isTestnet,
      );
      return {
        text: `Принудительное сжигание ${parsed.action.jettonAmount} жетонов (в единицах) у пользователя ${userAddress}; ${fromNano(parsed.tonAmount)} GRAM на газ`,
      };
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const op = slice.loadUint(32);
      // https://github.com/ton-blockchain/mytonctrl/blob/master/mytoncore/contracts/single-nominator-pool/single-nominator-code.fc#L98
      if (op === SINGLE_NOMINATOR_POOL_OP_WITHDRAW) {
        const queryId = slice.loadUint(64);
        const coins = slice.loadCoins();
        return {
          text: `Вывод ${fromNano(coins)} GRAM из пула единого номинатора.`,
        };
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const op = slice.loadUint(32);
      // https://github.com/ton-blockchain/mytonctrl/blob/master/mytoncore/contracts/single-nominator-pool/single-nominator-code.fc#L106
      if (op === SINGLE_NOMINATOR_POOL_OP_CHANGE_VALIDATOR_ADDRESS) {
        const queryId = slice.loadUint(64);
        const validatorAddress = slice.loadAddress();
        const validatorAddressUrl = await formatAddressAndUrl(
          validatorAddress,
          isTestnet,
        );

        return {
          text: `Сменить валидатора на ${validatorAddressUrl} в пуле единого номинатора.`,
        };
      }
    } catch (e) {}

    try {
      const slice = cell.beginParse();
      const op = slice.loadUint(32);
      if (op === VESTING_INTERNAL_TRANSFER) {
        const queryId = slice.loadUint(64);
        const sendMode = slice.loadUint(8);
        if (sendMode !== 3)
          throw new Error("only send mode 3 supported by vesting");
        const msg = slice.loadRef();
        endParse(slice);

        const messageRelaxed = loadMessageRelaxed(msg.beginParse());
        const messageRelaxedInfo =
          messageRelaxed.info as CommonMessageInfoRelaxedInternal;
        const messageBodyBoc = messageRelaxed.body.toBoc();
        const messageBody = messageRelaxed.body.beginParse();

        let actionString = "Затем отправить из вестинга ";
        const destAddress = await formatAddressAndUrl(
          messageRelaxedInfo.dest,
          isTestnet,
        );
        actionString += `${fromNano(messageRelaxedInfo.value.coins)} GRAM на ${destAddress}`;

        if (
          messageBody.remainingBits === 0 &&
          messageBody.remainingRefs === 0
        ) {
          // no payload
        } else if (
          messageBody.remainingBits > 32 &&
          messageBody.loadUint(32) == 0
        ) {
          actionString +=
            ' с текстом "' + sanitizeHTML(messageBody.loadStringTail()) + '".';
        } else {
          actionString += ` с данными: "${messageBodyBoc.toString("base64")}". `;
        }

        return { text: actionString };
      }
    } catch (e) {
      console.error(e);
    }

    return {
      text: `<b><span class="error">ВНИМАНИЕ - Неизвестное действие! Эта заявка содержит произвольные действия! Опасно! Не подписывайте, если точно не знаете, что делаете!</span></b><br>Необработанные данные тела сообщения: "${cell.toBoc().toString("base64")}".`,
    };
  };

  let parsedActions: string[] = [];
  let summaryGram = "";
  let summaryJetton: { amount: string; kind: "mint" | "transfer" } | undefined =
    undefined;

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
        sendModeString.push("Оплачивает комиссии отдельно");
      }
      if (sendMode & 2) {
        sendModeString.push("Игнорировать ошибки отправки");
      }
      if (sendMode & 128) {
        allBalance = true;
        sendModeString.push("ОТПРАВИТЬ ВЕСЬ БАЛАНС");
      }
      if (sendMode & 64) {
        sendModeString.push(
          "Перенести всю оставшуюся стоимость входящего сообщения",
        );
      }
      if (sendMode & 32) {
        throw new Error(
          "Заявка недействительна, потому что режим отправки (+32) удалит мультикошелек",
        );
      }

      const actionBody = slice.loadRef();
      endParse(slice);
      const messageRelaxed = loadMessageRelaxed(actionBody.beginParse());

      const info: CommonMessageInfoRelaxedInternal = messageRelaxed.info as any;

      if (info.ihrFee !== 0n) {
        throw new Error("Заявка недействительна: IHR-комиссия больше 0");
      }

      if (info.forwardFee !== 0n) {
        throw new Error("Заявка недействительна: форвард-комиссия больше 0");
      }

      const destAddress = await formatAddressAndUrl(info.dest, isTestnet);
      const gramAmount = allBalance
        ? "ВЕСЬ БАЛАНС"
        : fromNano(info.value.coins);
      actionString += `<div>Отправить ${gramAmount} GRAM на ${destAddress}</div>`;
      const parsedBody = await parseActionBody(messageRelaxed.body);
      actionString += `<div>${parsedBody.text}</div>`;
      if (sendMode) {
        actionString += `<div>Режим отправки: ${sendModeString.join(", ")}.</div>`;
      }

      if (!summaryGram) {
        summaryGram = allBalance ? "ВЕСЬ БАЛАНС" : `${gramAmount} GRAM`;
      }
      if (!summaryJetton && parsedBody.jetton) {
        summaryJetton = parsedBody.jetton;
      }
    } else if (actionOp === 0x1d0cfbd3) {
      // update_multisig_params
      const newThreshold = slice.loadUint(8);
      const newSigners = cellToArray(slice.loadRef());
      const newProposers = slice.loadUint(1)
        ? cellToArray(slice.loadRef())
        : [];
      endParse(slice);

      assert(newSigners.length > 0, "Invalid new signers");
      assert(newThreshold > 0, "Invalid new threshold");
      assert(newThreshold <= newSigners.length, "Invalid new threshold");

      actionString += `<div>Обновить параметры мультикошелька</div>`;
      actionString += `<div>Новый порог: ${newThreshold.toString()}</div>`;

      actionString += "<div>Новые подписанты:</div>";
      actionString += '<div class="daoAvatarGrid">';
      await fetchDnsNames(newSigners, isTestnet);
      for (let i = 0; i < newSigners.length; i++) {
        const f = await getAddressFormat(newSigners[i], isTestnet);
        actionString += addressAvatarHTML(
          f,
          false,
          undefined,
          getDnsName(newSigners[i]),
        );
      }
      actionString += "</div>";

      actionString += "<div>Новые инициаторы:</div>";
      if (newProposers.length > 0) {
        actionString += '<div class="daoAvatarGrid">';
        await fetchDnsNames(newProposers, isTestnet);
        for (let i = 0; i < newProposers.length; i++) {
          const f = await getAddressFormat(newProposers[i], isTestnet);
          actionString += addressAvatarHTML(
            f,
            false,
            undefined,
            getDnsName(newProposers[i]),
          );
        }
        actionString += "</div>";
      } else {
        actionString += "<div>Нет инициаторов</div>";
      }
    } else {
      throw new Error("Неизвестное действие");
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
    summary: {
      gram: summaryGram,
      ...(summaryJetton ? { jetton: summaryJetton } : {}),
    },
    stateInitMatches,
    isMismatchSigners,
    isMismatchThreshold,
  };
};
