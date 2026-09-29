import { describe, expect, test, spyOn } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import {
  deriveBamBoostClaimStatusAddress,
  verifyBamBoostClaimStatusAccount,
  estimateMarinadePayment,
  fetchMarinadeBondCosts,
  totals,
  renderCsv,
  renderMarkdown,
} from "./revenue";

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
