import { describe, expect, test } from "bun:test";

import {
  DOUBLEZERO_2Z_MINT as MINT,
  DOUBLEZERO_PUBLISHER_PROGRAM as PUBLISHER,
  DOUBLEZERO_SHRED_ORACLE_PROGRAM as SHRED,
  TOKEN_PROGRAMS,
  classifyTransaction,
  epochForSlot,
  fetchDoubleZeroRewards,
  formatTokenAmount,
  signaturesInWindow,
  type DoubleZeroRpc,
} from "./doublezero";

const IDENTITY = "R2D2imoV8nXk1ngT9v4dEK65We4uLNyUarTBdWbFruq";
const TOKEN_ACCOUNT = "EavmpzPGgxF82YU78oyw4WQiVvCb5TjwCns4R5sqJKNU";
const POOL_OWNER = "BKvFHgosv8a5rBuR6LtMvrBkmw5qDYrzhgGgkZCzDJYT";
const SCHEDULE = { slotsPerEpoch: 432_000, firstNormalEpoch: 0, firstNormalSlot: 0, warmup: false };
const owners = new Set([IDENTITY]);
const accounts = new Set([TOKEN_ACCOUNT]);

const balance = (accountIndex: number, owner: string, amount: string | bigint) =>
  ({ accountIndex, mint: MINT, owner, programId: TOKEN_PROGRAMS[0], uiTokenAmount: { amount: String(amount), decimals: 8 } });

function tx(options: {
  slot: number; program?: string; pre?: bigint | null; post?: bigint | null; logs?: string[]; signature?: string;
}) {
  const { slot, program = PUBLISHER, pre = 143_933_093_523n, post = 165_062_760_818n, logs = [], signature = `sig-${slot}` } = options;
  return {
    slot,
    blockTime: 1_792_967_675,
    meta: {
      err: null,
      logMessages: [`Program ${program} invoke [1]`, ...logs],
      preTokenBalances: [balance(2, POOL_OWNER, 1_000_000_000_000n), ...(pre === null ? [] : [balance(3, IDENTITY, pre)])],
      postTokenBalances: [balance(2, POOL_OWNER, 900_000_000_000n), ...(post === null ? [] : [balance(3, IDENTITY, post)])],
      innerInstructions: [{ instructions: [{ programId: TOKEN_PROGRAMS[0] }] }],
    },
    transaction: {
      signatures: [signature],
      message: { accountKeys: [{ pubkey: "payer" }, { pubkey: program }, { pubkey: "pool" }, { pubkey: TOKEN_ACCOUNT }], instructions: [{ programId: program }] },
    },
  };
}

const publisherLog = (raw: string, month: string, to = IDENTITY) =>
  `Program log: Distributed ${raw} ${MINT} to ${to} for leaf 31 of feed HaAJ3iaPaBQvyDR2iELte33joDps4Kf21CmoDdrgenCF for ${month}`;
const shredMemo = 'Program log: Memo (len 71): "dz-shred-oracle: distribute_validator_rewards epoch=1042 sub_epoch=1043"';

describe("DoubleZero 2Z classification", () => {
  test("amounts come from identity token balances; publisher logs only label the month", () => {
    const result = classifyTransaction(tx({ slot: 461_428_604, logs: [publisherLog("1", "2026-9"), publisherLog("5", "2026-7", POOL_OWNER)] }), owners, accounts);
    expect(result).toEqual({ source: "publisher", delta: 21_129_667_295n, labels: ["2026-9"] });
  });

  test("shred oracle memo labels the oracle epoch and a newly created account counts from zero", () => {
    const result = classifyTransaction(tx({ slot: 1, program: SHRED, pre: null, post: 7n, logs: [shredMemo] }), owners, accounts);
    expect(result).toEqual({ source: "shredOracle", delta: 7n, labels: ["epoch=1042 sub_epoch=1043"] });
  });

  test("a zero-amount distribution is still a distributor transaction", () => {
    expect(classifyTransaction(tx({ slot: 1, program: SHRED, pre: 5n, post: 5n }), owners, accounts).source).toBe("shredOracle");
  });

  test("other 2Z movements, and debits inside distributor transactions, are unclassified", () => {
    expect(classifyTransaction(tx({ slot: 1, program: "Other111", pre: 0n, post: 9n }), owners, accounts)).toEqual({ source: "unclassified", delta: 9n, labels: [] });
    expect(classifyTransaction(tx({ slot: 1, program: "Other111", pre: 9n, post: 0n }), owners, accounts).delta).toBe(-9n);
    expect(classifyTransaction(tx({ slot: 1, pre: 9n, post: 4n }), owners, accounts).source).toBe("unclassified");
    expect(classifyTransaction(tx({ slot: 1, program: "Other111", pre: 3n, post: 3n }), owners, accounts).source).toBeNull();
  });

  test("formats raw units exactly and attributes slots to epochs from the schedule", () => {
    expect(formatTokenAmount(11_679_758_700n, 8)).toBe("116.79758700");
    expect(formatTokenAmount(-5n, 8)).toBe("-0.00000005");
    expect(epochForSlot(460_724_151, SCHEDULE)).toBe(1066);
    expect(epochForSlot(461_391_145, SCHEDULE)).toBe(1068);
  });
});

function fakeRpc(options: { transactions: ReturnType<typeof tx>[]; fail?: string; pageLimit?: number }) {
  const calls: Array<{ method: string; params: any }> = [];
  const sorted = [...options.transactions].sort((a, b) => b.slot - a.slot);
  const rpc: DoubleZeroRpc = async (method: string, params: any = []) => {
    calls.push({ method, params });
    if (method === options.fail) throw new Error("RPC getTransaction failed; check connectivity and credentials (URL omitted).");
    switch (method) {
      case "getAccountInfo": return { value: { owner: TOKEN_PROGRAMS[0], data: { parsed: { type: "mint", info: { decimals: 8 } } } } } as any;
      case "getEpochSchedule": return SCHEDULE as any;
      case "getTokenAccountsByOwner": return { value: params[1].programId === TOKEN_PROGRAMS[0]
        ? [{ pubkey: TOKEN_ACCOUNT, account: { data: { parsed: { info: { mint: MINT } } } } }, { pubkey: "otherMintAccount", account: { data: { parsed: { info: { mint: "Other" } } } } }]
        : [] } as any;
      case "getSignaturesForAddress": {
        const limit = params[1].limit;
        const start = params[1].before ? sorted.findIndex((t) => t.transaction.signatures[0] === params[1].before) + 1 : 0;
        return sorted.slice(start, start + limit).map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, err: null })) as any;
      }
      case "getTransaction": return sorted.find((t) => t.transaction.signatures[0] === params[0]) as any;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

describe("DoubleZero 2Z scan", () => {
  const window = [
    tx({ slot: 461_428_604, logs: [publisherLog("1", "2026-9")], pre: 0n, post: 86_542_323_000n }),
    tx({ slot: 460_724_151, logs: [publisherLog("1", "2026-8")], pre: 0n, post: 11_679_758_700n }),
    tx({ slot: 460_724_200, program: "Other111", pre: 10n, post: 0n }),
  ];

  test("attributes receipts to the slot's epoch and keeps unclassified movements separate", async () => {
    const { rpc, calls } = fakeRpc({ transactions: [...window, tx({ slot: 455_000_000 })] });
    const report = await fetchDoubleZeroRewards(rpc, [IDENTITY, IDENTITY], 1059, 1068);
    expect(report.error).toBeNull();
    expect(report.decimals).toBe(8);
    expect(report.tokenAccounts).toEqual([TOKEN_ACCOUNT]);
    expect(report.epochs.get(1066)).toMatchObject({ status: "received", receivedRaw: 11_679_758_700n, publisherLabels: ["2026-8"], unclassifiedOutflowRaw: 10n });
    expect(report.epochs.get(1068)).toMatchObject({ status: "received", publisherRaw: 86_542_323_000n, publisherLabels: ["2026-9"] });
    expect(report.epochs.get(1065)?.status).toBe("none");
    // The pre-window transaction is listed by signatures but never fetched.
    expect(calls.filter((call) => call.method === "getTransaction")).toHaveLength(3);
    expect(calls.find((call) => call.method === "getTransaction")?.params[1].maxSupportedTransactionVersion).toBe(1);
  });

  test("paginates with before and stops once a page reaches before the window", async () => {
    const many = Array.from({ length: 2500 }, (_, index) => tx({ slot: 460_000_000 - index, signature: `s${index}` }));
    const { rpc, calls } = fakeRpc({ transactions: many });
    const found = await signaturesInWindow(rpc, TOKEN_ACCOUNT, 460_000_000 - 1500, 460_000_001);
    expect(found).toHaveLength(1501);
    const pages = calls.filter((call) => call.method === "getSignaturesForAddress");
    expect(pages).toHaveLength(2);
    expect(pages[1]!.params[1].before).toBe("s999");
  });

  test("an RPC failure marks every epoch unavailable instead of zero", async () => {
    const { rpc } = fakeRpc({ transactions: window, fail: "getTransaction" });
    const report = await fetchDoubleZeroRewards(rpc, [IDENTITY], 1066, 1068);
    expect(report.error).toContain("URL omitted");
    expect([...report.epochs.values()].map((epoch) => epoch.status)).toEqual(["unavailable", "unavailable", "unavailable"]);
  });
});
