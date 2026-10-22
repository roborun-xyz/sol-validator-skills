import { describe, expect, test } from "bun:test";

import {
  ALPENGLOW_VAT_LAMPORTS,
  assertVoteReserve,
  calculateActions,
  calculateTopUp,
  calculateVoteExcess,
  minimumVoteReserve,
  parseSolAmount,
  VOTE_RESERVE_MARGIN_LAMPORTS,
} from "./plan";

const SOL = 1_000_000_000n;
const RENT = 27_074_400n;
const RESERVE = 3n * SOL;
const IDENTITY_RESERVE = 5_001_000_000n;

describe("vote reserve policy", () => {
  test("defaults to a 3 SOL vote reserve", () => {
    const plan = calculateActions(3n * SOL, RENT, 5n * SOL);
    expect(plan.voteAction).toBe("skip-below-threshold");
    expect(plan.voteTransfer).toBe(0n);
    expect(plan.voteTopUp).toBe(0n);
  });

  test("rejects a reserve below rent exemption + 0.8 SOL VAT + margin", () => {
    const minimum = RENT + ALPENGLOW_VAT_LAMPORTS + VOTE_RESERVE_MARGIN_LAMPORTS;
    expect(minimumVoteReserve(RENT)).toBe(minimum);
    expect(() => assertVoteReserve(minimum - 1n, RENT)).toThrow("below the minimum");
    expect(() => assertVoteReserve(minimum, RENT)).not.toThrow();
    expect(() => calculateActions(10n * SOL, RENT, 10n * SOL, RENT)).toThrow("Alpenglow VAT");
    expect(() => calculateActions(10n * SOL, RENT, 10n * SOL, RENT + ALPENGLOW_VAT_LAMPORTS)).toThrow("below the minimum");
  });

  test("parses decimal SOL reserves exactly", () => {
    expect(parseSolAmount("3")).toBe(3n * SOL);
    expect(parseSolAmount("2.5")).toBe(2_500_000_000n);
    expect(parseSolAmount("0.000000001")).toBe(1n);
    expect(() => parseSolAmount("-1")).toThrow();
    expect(() => parseSolAmount("1.0000000001")).toThrow();
    expect(() => parseSolAmount("ALL")).toThrow();
  });
});

describe("step 1: vote top-up from identity surplus", () => {
  test("plans a full top-up when the vote account is below its reserve", () => {
    const plan = calculateActions(1n * SOL, RENT, 10n * SOL);
    expect(plan.voteAction).toBe("top-up");
    expect(plan.voteTopUp).toBe(2n * SOL);
    expect(plan.voteShortfall).toBe(0n);
    expect(plan.voteTransfer).toBe(0n);
    // Only the surplus left after the top-up funds the bond.
    expect(plan.identityTransfer).toBe(10n * SOL - IDENTITY_RESERVE - 2n * SOL);
    expect(plan.bondFund).toBe(plan.identityTransfer);
    expect(plan.expectedFinalIdentity).toBe(IDENTITY_RESERVE);
  });

  test("reports a shortfall and plans only a partial top-up when identity surplus is insufficient", () => {
    const plan = calculateActions(1n * SOL, RENT, 6n * SOL);
    expect(plan.voteAction).toBe("top-up-partial");
    expect(plan.voteTopUp).toBe(6n * SOL - IDENTITY_RESERVE);
    expect(plan.voteShortfall).toBe(2n * SOL - (6n * SOL - IDENTITY_RESERVE));
    expect(plan.bondFund).toBe(0n);
    expect(plan.expectedFinalIdentity).toBe(IDENTITY_RESERVE);
  });

  test("reports the full deficit as shortfall when the identity has no surplus", () => {
    for (const identity of [4n * SOL, 5n * SOL, IDENTITY_RESERVE]) {
      const plan = calculateActions(1n * SOL, RENT, identity);
      expect(plan.voteAction).toBe("shortfall-no-surplus");
      expect(plan.voteTopUp).toBe(0n);
      expect(plan.voteShortfall).toBe(2n * SOL);
      expect(plan.bondFund).toBe(0n);
      expect(plan.expectedFinalIdentity).toBe(identity);
    }
  });

  test("tops up a vote account that fell to rent exemption", () => {
    const plan = calculateActions(RENT, RENT, 20n * SOL);
    expect(plan.voteTopUp).toBe(RESERVE - RENT);
    expect(plan.voteShortfall).toBe(0n);
  });

  test("top-up helper is min(deficit, identity surplus)", () => {
    expect(calculateTopUp(2n * SOL, RESERVE, 20n * SOL)).toEqual({ deficit: SOL, topUp: SOL, shortfall: 0n });
    expect(calculateTopUp(2n * SOL, RESERVE, IDENTITY_RESERVE + 1n)).toEqual({ deficit: SOL, topUp: 1n, shortfall: SOL - 1n });
    expect(calculateTopUp(4n * SOL, RESERVE, 20n * SOL)).toEqual({ deficit: 0n, topUp: 0n, shortfall: 0n });
  });
});

describe("step 2: vote excess and identity surplus fund the bond", () => {
  test("withdraws only the excess above the vote reserve", () => {
    const plan = calculateActions(5n * SOL, RENT, 5n * SOL);
    expect(plan.voteAction).toBe("withdraw-excess");
    expect(plan.voteTransfer).toBe(2n * SOL);
    expect(calculateVoteExcess(5n * SOL, RESERVE)).toBe(2n * SOL);
    expect(5n * SOL - plan.voteTransfer).toBe(RESERVE);
    expect(plan.bondFund).toBe(2n * SOL);
    expect(plan.expectedFinalIdentity).toBe(5n * SOL);
  });

  test("honors a configured larger reserve", () => {
    const plan = calculateActions(5n * SOL, RENT, 5n * SOL, 4n * SOL);
    expect(plan.voteTransfer).toBe(SOL);
  });

  test("skips an excess below the withdrawal threshold", () => {
    const plan = calculateActions(RESERVE + 50_000_000n, RENT, 5n * SOL);
    expect(plan.voteAction).toBe("skip-below-threshold");
    expect(plan.voteTransfer).toBe(0n);
    expect(plan.bondFund).toBe(0n);
  });

  test("combines vote excess and identity surplus and leaves the execution reserve", () => {
    const plan = calculateActions(5n * SOL, RENT, 7n * SOL);
    expect(plan.voteTransfer).toBe(2n * SOL);
    expect(plan.identityTransfer).toBe(1_999_000_000n);
    expect(plan.bondFund).toBe(3_999_000_000n);
    expect(plan.expectedFinalIdentity).toBe(IDENTITY_RESERVE);
  });

  test("rejects vote sweeps that would leave the original identity below 5 SOL", () => {
    expect(() => calculateActions(5n * SOL, RENT, 4n * SOL)).toThrow("5 SOL hard floor");
    expect(() => calculateActions(5n * SOL, RENT, 5n * SOL - 1n)).toThrow("5 SOL hard floor");
  });

  test("treats an identity between 5 SOL and the execution reserve as a no-op", () => {
    const plan = calculateActions(RESERVE, RENT, 5_000_500_000n);
    expect(plan.identityAction).toBe("no-op-at-target");
    expect(plan.identityTransfer).toBe(0n);
    expect(plan.expectedFinalIdentity).toBe(5_000_500_000n);
  });
});
