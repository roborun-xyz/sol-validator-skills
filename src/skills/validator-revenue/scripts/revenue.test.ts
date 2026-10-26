import { describe, expect, test, spyOn } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import {
  deriveBamBoostClaimStatusAddress,
  verifyBamBoostClaimStatusAccount,
  estimateMarinadePayment,
  fetchMarinadeBondCosts,
  fetchBamBoostRewards,
  bamBoostIdentityNote,
  totals,
  renderCsv,
  renderMarkdown,
  fetchVatDebits,
  vatDebitFromRewards,
  vatDebitFromSvt,
  vatNotes,
  ALPENGLOW_FIRST_EPOCH,
  withDeprecatedAliases,
  sourceActivity,
  doubleZeroFields,
} from "./revenue";
import { emptyDoubleZeroEpoch } from "./doublezero";

const BAM_PROGRAM = "BoostxbPp2ENYHGcTLYt1obpcY13HE4NojdqNWdzqSSb";
const CLAIM_STATUS_DISCRIMINATOR = Buffer.from([
  22, 183, 249, 157, 247, 95, 150, 96,
]);
const R2D2_IDENTITY = "R2D2imoV8nXk1ngT9v4dEK65We4uLNyUarTBdWbFruq";

function claimStatusAccount(identity: string, amount: bigint) {
  const data = Buffer.alloc(48);
  CLAIM_STATUS_DISCRIMINATOR.copy(data, 0);
  new PublicKey(identity).toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  return {
    data: [data.toString("base64"), "base64"] as [string, string],
    owner: BAM_PROGRAM,
  };
}

describe("BAM Boost claim status", () => {
  test("derives the official R2D2 claim status PDA", () => {
    expect(deriveBamBoostClaimStatusAddress(R2D2_IDENTITY, 1028)).toBe(
      "EKbgiJ8yD4AYRDY3iT75bEAD628vs3kyHSNJ7y1dtD2a",
    );
  });

  test("accepts a matching finalized Claim Status account", () => {
    expect(() =>
      verifyBamBoostClaimStatusAccount(
        claimStatusAccount(R2D2_IDENTITY, 190_184_588n),
        R2D2_IDENTITY,
        190_184_588n,
      ),
    ).not.toThrow();
  });

  test("rejects a Claim Status amount that differs from the allocation", () => {
    expect(() =>
      verifyBamBoostClaimStatusAccount(
        claimStatusAccount(R2D2_IDENTITY, 190_184_587n),
        R2D2_IDENTITY,
        190_184_588n,
      ),
    ).toThrow("did not match allocation");
  });
});

const TEST_VOTE = "test-vote";
const samRow = (epoch = 100) => ({
  voteAccount: TEST_VOTE, epoch, effectiveBid: 0.04,
  revShare: { bidPmpe: 0.15 }, marinadeSamTargetSol: 70000,
  values: { marinadeActivatedStakeSol: 75000 },
});

describe("pending Marinade bidding costs", () => {
  test("uses the epoch's effective bid and activated stake, including valid zero", () => {
    expect(estimateMarinadePayment([samRow()], TEST_VOTE, 100).paymentSol).toBe(3);
    expect(estimateMarinadePayment([{ ...samRow(), effectiveBid: 0 }], TEST_VOTE, 100).paymentSol).toBe(0);
  });

  test("rejects missing, ambiguous, stale and invalid SAM inputs", () => {
    for (const payload of [null, [], [samRow(), samRow()], [samRow(99)],
      [{ ...samRow(), effectiveBid: -1 }], [{ ...samRow(), effectiveBid: "0.04" }],
      [{ ...samRow(), effectiveBid: NaN }], [{ ...samRow(), values: {} }],
      [{ ...samRow(), values: { marinadeActivatedStakeSol: Infinity } }]]) {
      expect(() => estimateMarinadePayment(payload, TEST_VOTE, 100)).toThrow();
    }
  });

  async function costs(events: unknown[], bondType = "bidding", sam: unknown = [samRow()], hasBond = true) {
    const calls: string[] = [];
    const mockFetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/bonds/")) return Response.json({ bonds: hasBond && url.endsWith(`/bonds/${bondType}`)
        ? [{ pubkey: "test-bond", vote_account: TEST_VOTE, bond_type: bondType }] : [] });
      if (url.endsWith("/protected-events")) return Response.json({ protected_events: events });
      if (url.endsWith("/scores/sam?epoch=100")) return Response.json(sam);
      throw new Error("Unexpected test URL");
    }, { preconnect: globalThis.fetch.preconnect });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    try { return { result: await fetchMarinadeBondCosts(TEST_VOTE, 100, 100), calls }; }
    finally { fetchMock.mockRestore(); }
  }

  const event = (vote = TEST_VOTE, reason = "Bidding") => ({
    epoch: 100, vote_account: vote, amount: 2500000000,
    meta: { funder: "ValidatorBond" }, reason,
  });

  test("estimates before bidding publication, retaining already reported PSR", async () => {
    const { result } = await costs([event(TEST_VOTE, "ProtectedEvent")]);
    expect(result.estimatesByEpoch.get(100)?.paymentSol).toBe(3);
    expect(result.paymentsByEpoch.get(100)).toBe(2500000000n);
  });

  test("published bidding replaces the estimate without double counting", async () => {
    const { result, calls } = await costs([event()]);
    expect(result.paymentsByEpoch.get(100)).toBe(2500000000n);
    expect(result.estimatesByEpoch.size).toBe(0);
    expect(calls.some(url => url.includes("/scores/"))).toBe(false);
  });

  test("global bidding publication leaves missing validator rows as no record", async () => {
    const { result } = await costs([event("other-vote")]);
    expect(result.paymentsByEpoch.size).toBe(0);
    expect(result.estimatesByEpoch.size).toBe(0);
  });

  test("does not use SAM for institutional-only or absent bonds", async () => {
    expect((await costs([], "institutional")).result.estimatesByEpoch.size).toBe(0);
    const { result, calls } = await costs([], "bidding", [], false);
    expect(result.hasBond).toBe(false);
    expect(calls.some(url => url.includes("/scores/"))).toBe(false);
  });

  test("unavailable SAM rows fail instead of reporting zero costs", async () => {
    await expect(costs([], "bidding", [])).rejects.toThrow("Cannot estimate Marinade payment");
  });

  test("exports separate amounts, provenance and provisional net totals", () => {
    const row = { ...totals([]), epoch: 100, marinadeBondPaymentSol: 2,
      marinadeBondEstimatedPaymentSol: 3, marinadeBondPaymentStatus: "estimated",
      marinadeEffectiveBid: 0.04, marinadeActivatedStakeSol: 75000,
      marinadeEstimateSource: "https://scoring.marinade.finance/api/v1/scores/sam?epoch=100",
      netRevenueSol: 4 };
    const total = totals([row, row]);
    expect(total.marinadeBondPaymentSol).toBe(4);
    expect(total.marinadeBondEstimatedPaymentSol).toBe(6);
    expect(total.marinadeBondPaymentStatus).toBe("estimated");
    const csv = renderCsv([row], true).split("\n").map(line => line.split(","));
    expect(csv[0]?.length).toBe(csv[1]?.length);
    expect(csv[1]?.[csv[0]!.indexOf("marinade_bond_estimated_payment_sol")]).toBe("3.000000000");
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 101,
      firstEpoch: 100, lastEpoch: 100, rows: [row], hasMarinadeBond: true, marinadeBondAccounts: [] });
    expect(md).toContain("includes estimated Marinade costs");
    expect(md).toContain("75000 SOL activated stake × effective bid 0.04");
  });
});

describe("BAM Boost identity resolution", () => {
  const OLDER_IDENTITY = "11111111111111111111111111111111";
  async function rewards(fallback?: Map<number, string>) {
    const mockFetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Trillium serves only the most recent epoch in this fixture.
      if (url.includes("api.trillium.so")) return Response.json([{ epoch: 101, vote_account_pubkey: TEST_VOTE, identity_pubkey: R2D2_IDENTITY }]);
      if (url.endsWith("/101/merkle_tree.json")) return Response.json([{ pubkey: OLDER_IDENTITY, amount: "7" }, { pubkey: "other", amount: "9" }]);
      if (url.endsWith("/102/merkle_tree.json")) return Response.json([{ pubkey: R2D2_IDENTITY, amount: 5 }]);
      throw new Error("Unexpected test URL");
    }, { preconnect: globalThis.fetch.preconnect });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    try { return await fetchBamBoostRewards(TEST_VOTE, 100, 101, fallback); }
    finally { fetchMock.mockRestore(); }
  }

  test("epochs outside Trillium's window use the history row identity and record the source", async () => {
    const result = await rewards(new Map([[100, OLDER_IDENTITY], [101, OLDER_IDENTITY]]));
    expect(result.get(100)).toMatchObject({ status: "allocated", amount: 7n, identityAccount: OLDER_IDENTITY, identitySource: "svt-history" });
    expect(result.get(101)).toMatchObject({ status: "allocated", amount: 5n, identityAccount: R2D2_IDENTITY, identitySource: "trillium" });
  });

  test("an epoch with no identity from either source stays identity_missing instead of zero", async () => {
    expect((await rewards()).get(100)).toMatchObject({ status: "identity_missing", amount: 0n, identityAccount: null, identitySource: null });
  });

  test("Markdown states which epochs were resolved through the history row", () => {
    const row = (epoch: number, source: "trillium" | "svt-history", status: "allocated" | "not_allocated") =>
      ({ ...totals([]), epoch, bamBoostIdentitySource: source, bamBoostAllocationStatus: status });
    const rows = [row(97, "svt-history", "not_allocated"), row(98, "svt-history", "allocated"), row(99, "trillium", "not_allocated"), row(100, "svt-history", "not_allocated")];
    expect(bamBoostIdentityNote(rows)).toEqual([expect.stringContaining("epochs `97-98, 100` came from that epoch's JPool/SVT history row")]);
    expect(bamBoostIdentityNote([row(99, "trillium", "not_allocated")])).toEqual([]);
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 101, firstEpoch: 97, lastEpoch: 100, rows, hasMarinadeBond: false, marinadeBondAccounts: [] });
    expect(md).toContain("JPool/SVT history row because Trillium's validator history does not cover them");
  });

  test("CSV keeps header and row aligned with the identity source column", () => {
    const row = { ...totals([]), epoch: 100, bamBoostIdentitySource: "svt-history" as const, skipRate: "2.5000" };
    const csv = renderCsv([row], false).split("\n").map(line => line.split(","));
    expect(csv[0]?.length).toBe(csv[1]?.length);
    expect(csv[1]?.[csv[0]!.indexOf("bam_boost_identity_source")]).toBe("svt-history");
    expect(csv[1]?.[csv[0]!.indexOf("skip_rate_pct")]).toBe("2.5000");
  });
});

describe("Markdown layout", () => {
  const columns = (line: string) => line.split("|").length - 2;
  // Every optional SOL source has activity, so every optional column is shown.
  const active = { jitoRewardSol: 0.1, votingCompensationSol: 0.1, votingFeeSol: 0.1 };

  test("the main table stays narrow and the rate timestamps move to the detail table", () => {
    const row = {
      ...totals([]), ...active, epoch: 100, jitoCommissionBps: 800, bamBoostClaimEpoch: 101,
      bamBoostJitoSolToSolRate: 1.304624952, bamBoostRateTimestampUtc: "2026-10-04T23:07:59Z", bamBoostRateTimestampLocal: "2026-10-04T16:07:59-07:00",
      bamBoostAllocationStatus: "allocated" as const, bamBoostClaimStatus: "claimed" as const,
    };
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 101, firstEpoch: 100, lastEpoch: 100, rows: [row], hasMarinadeBond: false, marinadeBondAccounts: [] });
    const tables = md.split("\n").filter(line => line.startsWith("| Epoch"));
    expect(tables).toHaveLength(2);
    expect(columns(tables[0]!)).toBe(12);
    expect(tables[0]).not.toContain("JitoSOL/SOL");
    expect(tables[1]).toContain("Rate Time (UTC)");
    const [mainRow, detailRow] = md.split("\n").filter(line => line.startsWith("| 100 |"));
    expect(detailRow).toBeDefined();
    expect(columns(mainRow!)).toBe(12);
    expect(mainRow).not.toContain("2026-10-04");
    expect(detailRow).toContain("| 800 |");
    expect(detailRow).toContain("| 1.304624952 | 2026-10-04T23:07:59Z | 2026-10-04T16:07:59-07:00 |");
    expect(detailRow).toContain("allocated/claimed");
  });

  test("a Marinade bond adds exactly one column to the main table", () => {
    const row = { ...totals([]), ...active, epoch: 100, bamBoostAllocationStatus: "allocated" as const, marinadeBondPaymentSol: 2, marinadeBondPaymentStatus: "paid" as const };
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 101, firstEpoch: 100, lastEpoch: 100, rows: [row], hasMarinadeBond: true, marinadeBondAccounts: [] });
    const [header, , body] = md.split("\n").filter(line => line.startsWith("| Epoch") || line.startsWith("|---") || line.startsWith("| 100 |"));
    expect(columns(header!)).toBe(13);
    expect(columns(body!)).toBe(13);
    expect(body).toContain("2.000000 (paid)");
  });
});

describe("block fee rewards", () => {
  // SVT votingReward equals the identity's getBlock "Fee" rewards (verified for epochs 1063-1066), so it is labelled as block fees.
  const row = { ...totals([]), epoch: 1066, blockFeeRewardSol: 3.571743478, commissionRewardSol: 0.832936742 };

  test("Markdown labels the column and total as block fees, never voting reward", () => {
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 1067, firstEpoch: 1066, lastEpoch: 1066, rows: [row], hasMarinadeBond: false, marinadeBondAccounts: [] });
    const header = md.split("\n").find(line => line.startsWith("| Epoch | Stake SOL"));
    expect(header).toContain("| Block Fees |");
    expect(md).toContain("- Block fee rewards (leader): `3.571743478 SOL`");
    expect(md).toContain("gross = block fee rewards (leader) + commissionReward");
    expect(md).toContain("rewards of type Fee");
    expect(md.toLowerCase()).not.toContain("voting reward");
  });

  test("CSV uses block_fee_reward_sol and keeps the deprecated voting_reward_sol alias with the same value", () => {
    const csv = renderCsv([row], false).split("\n").map(line => line.split(","));
    expect(csv[0]?.length).toBe(csv[1]?.length);
    expect(csv[1]?.[csv[0]!.indexOf("block_fee_reward_sol")]).toBe("3.571743478");
    expect(csv[0]?.at(-1)).toBe("voting_reward_sol");
    expect(csv[1]?.at(-1)).toBe("3.571743478");
  });

  test("JSON rows gain the deprecated votingRewardSol alias without changing the canonical field", () => {
    const aliased = withDeprecatedAliases(row);
    expect(aliased.blockFeeRewardSol).toBe(3.571743478);
    expect(aliased.votingRewardSol).toBe(3.571743478);
    expect('votingRewardSol' in row).toBe(false);
  });
});

describe("Alpenglow VAT", () => {
  const VOTE = "R2D2vs3bJwpNF2ejaB6UW1JdCZ5VstuAmuwxDuUUWNj";
  const FIRST_SLOT_1064 = 459_648_000;
  const vatReward = (pubkey = VOTE) => ({ pubkey, lamports: -800_000_000, postBalance: 1, rewardType: "VATDebit", commission: null });

  async function vat(svt: Map<number, unknown>, epochs: number[], blockRewards: unknown[] | "fail") {
    const methods: string[] = [];
    const mockFetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body));
      methods.push(method);
      const result = method === "getEpochSchedule" ? { slotsPerEpoch: 432_000, firstNormalEpoch: 0, firstNormalSlot: 0 }
        : method === "getBlocks" ? [params[0]]
        : method === "getBlock" ? (blockRewards === "fail" ? undefined : { rewards: blockRewards })
        : undefined;
      return result === undefined ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32009, message: "skipped" } })
        : Response.json({ jsonrpc: "2.0", id: 1, result });
    }, { preconnect: globalThis.fetch.preconnect });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    try { return { result: await fetchVatDebits("http://rpc.test", VOTE, svt, epochs), methods }; }
    finally { fetchMock.mockRestore(); }
  }

  test("parses the VATDebit block reward and SVT vatDebit as positive costs", () => {
    expect(vatDebitFromRewards([vatReward(), vatReward("other"), { pubkey: VOTE, lamports: 5, rewardType: "Voting" }], VOTE)).toBe(800_000_000n);
    expect(vatDebitFromRewards([vatReward("other")], VOTE)).toBeNull();
    expect(vatDebitFromSvt(null)).toBeNull();
    expect(vatDebitFromSvt(undefined)).toBeNull();
    expect(vatDebitFromSvt("800000000")).toBe(800_000_000n);
    expect(vatDebitFromSvt(-800_000_000)).toBe(800_000_000n);
    for (const bad of ["0.8", 0.8, "x", {}]) expect(() => vatDebitFromSvt(bad)).toThrow("invalid vatDebit");
  });

  test("pre-Alpenglow epochs are zero without RPC; SVT vatDebit is preferred", async () => {
    const { result, methods } = await vat(new Map([[ALPENGLOW_FIRST_EPOCH, "800000000"]]), [1063, 1064], "fail");
    expect(result.get(1063)).toEqual({ lamports: 0n, status: "pre_alpenglow", block: null });
    expect(result.get(1064)).toEqual({ lamports: 800_000_000n, status: "svt", block: null });
    expect(methods).toEqual([]);
  });

  test("reads the first confirmed block of the epoch when SVT vatDebit is null", async () => {
    const { result } = await vat(new Map([[1064, null]]), [1064], [vatReward("other"), vatReward()]);
    expect(result.get(1064)).toEqual({ lamports: 800_000_000n, status: "rpc_block", block: FIRST_SLOT_1064 });
  });

  test("absent reward is provisional and unavailable block is missing, never silently zero", async () => {
    expect((await vat(new Map(), [1064], [vatReward("other")])).result.get(1064)?.status).toBe("rpc_absent");
    expect((await vat(new Map(), [1065], "fail")).result.get(1065)).toEqual({ lamports: 0n, status: "missing", block: null });
  });

  test("outputs carry VAT columns, deduct it in totals and flag provisional epochs loudly", () => {
    const base = { ...totals([]), grossRevenueSol: 2, votingFeeSol: 0.1 };
    const rows = [
      { ...base, epoch: 1063, vatStatus: "pre_alpenglow" as const, netRevenueSol: 1.9 },
      { ...base, epoch: 1064, vatSol: 0.8, vatStatus: "rpc_block" as const, vatBlock: FIRST_SLOT_1064, netRevenueSol: 1.1 },
      { ...base, epoch: 1065, vatStatus: "missing" as const, admissionFailure: true, netRevenueSol: 1.9 },
    ];
    const total = totals(rows);
    expect(total.vatSol).toBe(0.8);
    expect(total.vatStatus).toBe("missing");
    expect(total.admissionFailure).toBe(true);
    const csv = renderCsv(rows, false).split("\n").map(line => line.split(","));
    expect(csv[0]?.length).toBe(csv[1]?.length);
    expect(csv[2]?.[csv[0]!.indexOf("vat_sol")]).toBe("0.800000000");
    expect(csv[2]?.[csv[0]!.indexOf("vat_block")]).toBe(String(FIRST_SLOT_1064));
    expect(csv[3]?.[csv[0]!.indexOf("vat_status")]).toBe("missing");
    expect(csv[3]?.[csv[0]!.indexOf("admission_failure")]).toBe("true");
    expect(vatNotes(rows)).toEqual([expect.stringContaining("VAT is unknown for epoch(s) `1065`"), expect.stringContaining("admissionFailure=true for epoch(s) `1065`")]);
    const md = renderMarkdown({ voteAccount: VOTE, currentEpoch: 1066, firstEpoch: 1063, lastEpoch: 1065, rows, hasMarinadeBond: false, marinadeBondAccounts: [] });
    expect(md).toContain("net = gross - vote transaction fees (TowerBFT; partial in 1064) - VAT");
    expect(md).toContain("attributed to the epoch in which it is debited");
    expect(md).toContain("| 0.800000 (rpc_block) |");
    expect(md).toContain("(missing, PROVISIONAL) ADMISSION FAILURE");
    expect(md).toContain("- VAT (attributed to the debit epoch) (PROVISIONAL");
    expect(md).toContain("Net revenue (PROVISIONAL: VAT missing or unverified for some epochs)");
  });
});

describe("optional source columns", () => {
  const base = { ...totals([]), bamBoostAllocationStatus: "not_allocated" as const, doubleZeroRewardStatus: "none" as const, doubleZeroDecimals: 8 };
  const render = (rows: ReturnType<typeof totals>[], currentEpoch = 1069) =>
    renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch, firstEpoch: rows[0]!.epoch, lastEpoch: rows.at(-1)!.epoch, rows, hasMarinadeBond: false, marinadeBondAccounts: [] });
  const mainHeader = (md: string) => md.split("\n").find((line) => line.startsWith("| Epoch | Stake SOL"))!;

  test("a validator without DoubleZero or BAM hides those columns and says so", () => {
    const rows = [{ ...base, epoch: 1067, jitoRewardSol: 1 }, { ...base, epoch: 1068, bamBoostAllocationStatus: "not_published" as const }];
    const md = render(rows, 1068);
    expect(sourceActivity(rows, { currentEpoch: 1068, hasMarinadeBond: false }).omittedSources)
      .toEqual(["bamBoost", "votingCompensation", "voteTxFees", "marinadeBond", "doubleZero"]);
    expect(mainHeader(md)).toBe("| Epoch | Stake SOL | Block Fees | Commission | Jito Commission | Gross SOL | VAT | Net SOL | Blocks |");
    expect(md).toContain("Omitted as having no activity in epochs `1067-1068`: BAM Boost, voting compensation, vote transaction fees, Marinade bond, DoubleZero 2Z rewards.");
    expect(md).not.toContain("BAM Boost allocated");
    expect(md).not.toContain("JitoSOL/SOL");
    expect(md).not.toContain("| Receipt Epoch");
    expect(md).not.toContain("DoubleZero 2Z received");
    // CSV keeps a stable column set regardless of activity.
    const csv = renderCsv(rows, false).split("\n")[0]!.split(",");
    expect(csv).toContain("bam_boost_allocated_jitosol");
    expect(csv).toContain("double_zero_reward_2z");
  });

  test("BAM allocated only in an earlier epoch of the window keeps BAM columns", () => {
    const rows = [{ ...base, epoch: 1060, bamBoostAllocationStatus: "allocated" as const }, { ...base, epoch: 1061 }];
    const md = render(rows);
    expect(mainHeader(md)).toContain("| BAM Boost SOL Eq. |");
    expect(md).toContain("BAM Boost allocated");
    expect(md).toContain("| BAM Status |");
  });

  test("unknown data is never hidden as inactive", () => {
    const rows = [
      { ...base, epoch: 1066, bamBoostAllocationStatus: "not_published" as const, ...doubleZeroFields(undefined, null) },
      { ...base, epoch: 1067, bamBoostAllocationStatus: "identity_missing" as const, doubleZeroRewardStatus: "unavailable" as const },
    ];
    const { activeSources } = sourceActivity(rows, { currentEpoch: 1068, hasMarinadeBond: false });
    expect(activeSources).toEqual(["bamBoost", "doubleZero"]);
    const md = renderMarkdown({ voteAccount: TEST_VOTE, currentEpoch: 1068, firstEpoch: 1066, lastEpoch: 1067, rows, hasMarinadeBond: false, marinadeBondAccounts: [], doubleZero: { error: "RPC failed" } });
    expect(md).toContain("| Receipt Epoch |");
    expect(md).toContain("DoubleZero 2Z rewards are unavailable for epoch(s) `1066, 1067` (RPC failed); they are unknown, not zero.");
    expect(md).toContain("(INCOMPLETE: unavailable epochs listed above)");
    expect(mainHeader(md)).toContain("BAM Boost SOL Eq.");
  });

  test("2Z receipts are a separate token line and never change gross or net", () => {
    const received = { ...emptyDoubleZeroEpoch(1066, "received"), receivedRaw: 11_679_758_700n, publisherRaw: 11_679_758_700n, publisherTxCount: 14, publisherLabels: ["2026-8"] };
    const rows = [
      { ...base, epoch: 1066, grossRevenueSol: 2, netRevenueSol: 1, ...doubleZeroFields(received, 8) },
      { ...base, epoch: 1067, grossRevenueSol: 2, netRevenueSol: 1, ...doubleZeroFields(emptyDoubleZeroEpoch(1067, "none"), 8) },
    ];
    const total = totals(rows);
    expect(total.grossRevenueSol).toBe(4);
    expect(total.netRevenueSol).toBe(2);
    expect(total.doubleZeroReward2zRaw).toBe("11679758700");
    expect(rows[0]!.doubleZeroSources?.publisher).toEqual({ amount2z: 116.797587, amountRaw: "11679758700", txCount: 14, rewardMonths: ["2026-8"] });
    const md = render(rows);
    expect(md).toContain("| 1066 | 116.79758700 | received | 116.79758700 | 0.00000000 | publisher 2026-8 | 0.00000000/0.00000000 |");
    expect(md).toContain("- DoubleZero 2Z received (receipt epochs; separate token line, NOT in gross or net): `116.79758700 2Z`");
    const csv = renderCsv(rows, false).split("\n").map((line) => line.split(","));
    expect(csv[0]?.length).toBe(csv[1]?.length);
    expect(csv[1]?.[csv[0]!.indexOf("double_zero_reward_2z")]).toBe("116.79758700");
    expect(csv[1]?.[csv[0]!.indexOf("double_zero_reward_2z_raw")]).toBe("11679758700");
    expect(csv[1]?.[csv[0]!.indexOf("double_zero_reward_status")]).toBe("received");
    expect(csv[0]?.at(-1)).toBe("voting_reward_sol");
  });
});
