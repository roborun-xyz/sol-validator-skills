import { test, expect } from "bun:test";
import { normalizePerformanceRow, renderCsv, renderMarkdown, windowNotes } from "./performance";

const source = { epoch: 99, validatorId: "fixture-identity", voteId: "fixture-vote" };

test("missing upstream metrics stay unavailable rather than zero stake or 100 percent skipped", () => {
  const row = normalizePerformanceRow({ ...source, leaderSlotsTotal: 10 });
  expect(row).toMatchObject({
    stakeSol: null, voteCredits: null, tvcPctOfMax: null, tvcRank: null,
    leaderSlots: 10, blocksProduced: null, blockProductionPct: null, skipRatePct: null,
    commissionPct: null, mevCommissionPct: null,
  });
  const csvValues = renderCsv([row]).split("\n")[1].split(",");
  expect(csvValues).toEqual(["99", "", "", "", "", "", "10", "", "", "", "", "false"]);
  expect(JSON.parse(JSON.stringify(row)).blocksProduced).toBeNull();
});

test("known zero values remain zero and a verified zero block count can mean 100 percent skipped", () => {
  const row = normalizePerformanceRow({ ...source, tvCredits: 0, totalStake: "0", leaderSlotsTotal: 10, leaderSlotsDone: 0, fee: 0, mevCommission: 0 });
  expect(row).toMatchObject({ stakeSol: 0, voteCredits: 0, tvcPctOfMax: 0, blocksProduced: 0, blockProductionPct: 0, skipRatePct: 100, commissionPct: 0, mevCommissionPct: 0 });
});

test("invalid and null provider values do not become fabricated metrics", () => {
  const row = normalizePerformanceRow({ ...source, totalStake: "bad", tvCredits: Number.NaN, leaderSlotsTotal: 10, leaderSlotsDone: -1, fee: null as never, mevCommission: null as never, skippedSlots: "bad" });
  expect(row).toMatchObject({ stakeSol: null, voteCredits: null, blocksProduced: null, blockProductionPct: null, skipRatePct: null, commissionPct: null, mevCommissionPct: null });
  expect(normalizePerformanceRow({ ...source, totalStake: Number.MAX_SAFE_INTEGER + 1 }).stakeSol).toBeNull();
});

test("upstream skippedSlots is a vote-credit shortfall and never becomes a block skip rate", () => {
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 10, skippedSlots: "0.25" }).skipRatePct).toBeNull();
  // Observed SVT placeholder for an in-progress epoch: no leader slots yet and skippedSlots 1.
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 0, leaderSlotsDone: 0, skippedSlots: 1 }).skipRatePct).toBeNull();
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 0, leaderSlotsDone: 0 }).blockProductionPct).toBeNull();
  expect(normalizePerformanceRow({ ...source, leaderSlotsTotal: 10, leaderSlotsDone: 9, skippedSlots: 0.001 }).skipRatePct).toBe(10);
});

test("an in-progress epoch is marked and excluded from the window summary", () => {
  const completed = normalizePerformanceRow({ ...source, epoch: 98, tvCredits: 6_912_000, tvcRank: 5, leaderSlotsTotal: 10, leaderSlotsDone: 10, fee: 5, mevCommission: 1000 });
  const partial = normalizePerformanceRow({ ...source, tvCredits: 0, tvcRank: 0, leaderSlotsTotal: 0, leaderSlotsDone: 0, fee: 5, mevCommission: 0, skippedSlots: 1 }, true);
  // Upstream's zero credits and leader slots for the in-progress epoch are placeholders.
  expect(partial).toMatchObject({ inProgress: true, voteCredits: null, leaderSlots: null, blocksProduced: null, tvcPctOfMax: null, tvcRank: null, skipRatePct: null, mevCommissionPct: null, commissionPct: 5 });
  // A zero MEV commission in a completed epoch is a real value.
  expect(normalizePerformanceRow({ ...source, mevCommission: 0 }).mevCommissionPct).toBe(0);
  expect(normalizePerformanceRow({ ...source, tvCredits: 1_000, leaderSlotsTotal: 4, leaderSlotsDone: 4 }, true)).toMatchObject({ voteCredits: 1_000, leaderSlots: 4, blocksProduced: 4 });
  const csv = renderCsv([completed, partial]).split("\n").map((line) => line.split(","));
  expect(csv[0].at(-1)).toBe("in_progress");
  expect([csv[1].at(-1), csv[2].at(-1)]).toEqual(["false", "true"]);
  expect(csv[2].slice(2, 7)).toEqual(["", "", "", "", ""]);
  expect(csv[2].slice(9, 11)).toEqual(["5", ""]);
  const output = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 99, currentSlotIndex: 1, slotsInEpoch: 432_000,
    requestedFirstEpoch: 97, firstEpoch: 98, lastEpoch: 99, inProgressEpoch: 99, rows: [completed, partial],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(output).toContain("| 99 (in progress) |");
  expect(output).toContain("Window summary (epochs `98-98`)");
  expect(output).toContain("Avg TVC % of max: `100.00%`");
  expect(output).toContain("Avg skip rate: `0.00%`");
  expect(output).toContain("Avg MEV commission: `10.0%`");
  expect(output).toContain("Total vote credits: `6,912,000`");
  expect(output).toContain("returned no rows before epoch `98`, so epochs `97-97` are unavailable");
  expect(windowNotes({ firstEpoch: 98, lastEpoch: 99 })).toEqual([]);
  // A window with no completed epoch has no totals; it must not print totals of zero.
  const onlyPartial = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 99, currentSlotIndex: 1, slotsInEpoch: 432_000,
    firstEpoch: 99, lastEpoch: 99, inProgressEpoch: 99, rows: [partial],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(onlyPartial).toContain("Window summary (no completed epochs in the window):");
  expect(onlyPartial).toContain("Total vote credits: `—`");
  expect(onlyPartial).toContain("Block production: `— / —`");
});

test("markdown shows missing fields and does not present partial window sums as totals", () => {
  const missing = normalizePerformanceRow({ ...source, leaderSlotsTotal: 10 });
  const known = normalizePerformanceRow({ ...source, epoch: 98, tvCredits: 100, leaderSlotsTotal: 10, leaderSlotsDone: 9 });
  const output = renderMarkdown({
    voteAccount: "fixture-vote", currentEpoch: 100, currentSlotIndex: 1, slotsInEpoch: 432_000,
    firstEpoch: 98, lastEpoch: 99, rows: [known, missing],
    current: { isDelinquent: null, activatedStakeSol: null, liveCommissionPct: null, nodePubkey: null },
  });
  expect(output).toContain("| 99 | — | — | — | — | —/10 | — | — | — | — |");
  expect(output).toContain("Total vote credits: `—`");
  expect(output).toContain("Block production: `— / 20`");
  expect(output).toContain("Averages use available epochs");
  expect(output).not.toContain("100.00%");
});
