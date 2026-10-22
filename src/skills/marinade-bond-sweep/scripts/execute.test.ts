import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, SystemProgram, VoteProgram } from "@solana/web3.js";

import {
  approvalFingerprint,
  assertVoteAtOrAboveReserve,
  buildTopUpTransaction,
  buildVoteWithdrawTransaction,
  calculateExecutionWithdrawal,
  calculateFundingAfterVote,
  explicitSolAmount,
  formatSol,
  matchFundingTransaction,
  parseSolLamports,
  parseWithdrawalSignature,
} from "./execute";

describe("amount handling", () => {
  test("parses and formats nine-decimal bond amounts exactly", () => {
    expect(parseSolLamports("65.861744172 SOLs")).toBe(65_861_744_172n);
    expect(parseSolLamports("0 SOL")).toBe(0n);
    expect(formatSol(9_964_279_320n)).toBe("9.964279320");
  });

  test("recalculates an above-reserve identity after the vote step", () => {
    expect(calculateFundingAfterVote({ identityAction: "fund-bond" }, 14_967_009_320n, 4_629_251_536n)).toBe(9_966_009_320n);
    // After a full top-up the identity sits at its execution reserve: nothing left for the bond.
    expect(calculateFundingAfterVote({ identityAction: "fund-bond" }, 5_001_000_000n, 0n)).toBe(0n);
  });

  test("does not consume an initially below-target identity", () => {
    expect(calculateFundingAfterVote({ identityAction: "skip-below-threshold" }, 5_972_925_600n, 1_972_925_600n)).toBe(1_972_925_600n);
    expect(calculateFundingAfterVote({ identityAction: "no-op-at-target" }, 5_000_500_000n, 0n)).toBe(0n);
  });
});

describe("vote reserve during execution", () => {
  const SOL = 1_000_000_000n;
  const RESERVE = 3n * SOL;

  test("withdraws the current excess but never more than the approved amount", () => {
    expect(calculateExecutionWithdrawal(5n * SOL, RESERVE, 2n * SOL)).toBe(2n * SOL);
    // Block revenue routed to the vote account after planning stays there.
    expect(calculateExecutionWithdrawal(9n * SOL, RESERVE, 2n * SOL)).toBe(2n * SOL);
    // A shrunken excess withdraws less, and none at all is a skip rather than a failure.
    expect(calculateExecutionWithdrawal(4n * SOL, RESERVE, 2n * SOL)).toBe(SOL);
    expect(calculateExecutionWithdrawal(2n * SOL, RESERVE, 2n * SOL)).toBe(0n);
  });

  test("post-withdrawal check requires at least the reserve, not exactly rent", () => {
    expect(() => assertVoteAtOrAboveReserve(RESERVE, RESERVE, "after withdrawal")).not.toThrow();
    expect(() => assertVoteAtOrAboveReserve(RESERVE + 5n * SOL, RESERVE, "after withdrawal")).not.toThrow();
    expect(() => assertVoteAtOrAboveReserve(RESERVE - 1n, RESERVE, "after withdrawal")).toThrow("below the vote reserve");
    expect(() => assertVoteAtOrAboveReserve(27_074_400n, RESERVE, "after withdrawal")).toThrow("below the vote reserve");
  });

  test("never withdraws ALL", () => {
    expect(explicitSolAmount(2n * SOL)).toBe("2.000000000");
    expect(() => explicitSolAmount(0n)).toThrow("non-positive");
    const source = readFileSync(resolve(import.meta.dir, "execute.ts"), "utf8");
    expect(source).not.toMatch(/["']ALL["']/);
  });

  const [feePayer, identity, vote, withdrawer] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());

  test("builds the top-up as a plain System transfer signed by the identity", () => {
    const transaction = buildTopUpTransaction(feePayer, identity, vote, 2n * SOL);
    expect(transaction.instructions).toHaveLength(1);
    const [instruction] = transaction.instructions;
    expect(instruction.programId.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([[identity, true], [vote, false]]);
    expect(instruction.data.readBigUInt64LE(4)).toBe(2n * SOL);
    expect(transaction.feePayer?.toBase58()).toBe(feePayer);
  });

  test("builds the withdrawal with an explicit lamport amount", () => {
    const transaction = buildVoteWithdrawTransaction(feePayer, vote, withdrawer, identity, 2n * SOL);
    const [instruction] = transaction.instructions;
    expect(instruction.programId.equals(VoteProgram.programId)).toBe(true);
    expect(instruction.data.readBigUInt64LE(4)).toBe(2n * SOL);
    expect(() => buildVoteWithdrawTransaction(feePayer, vote, withdrawer, identity, 0n)).toThrow();
  });
});

describe("approval gate", () => {
  const approvedState = {
    voteAccount: "vote",
    identity: "identity",
    bond: "bond",
    bondAuthority: "identity",
    identitySigner: "identity",
    withdrawerSigner: "withdrawer",
    feePayerSigner: "fee-payer",
    voteAction: "withdraw-excess" as const,
    voteReserveLamports: "3000000000",
    willTopUpVote: false,
    willFundBond: true,
    approvedTopUpCeilingLamports: "0",
    approvedCeilingLamports: "10000000000",
  };

  test("is deterministic for the approved non-balance state", () => {
    expect(approvalFingerprint(approvedState)).toBe(approvalFingerprint({ ...approvedState }));
  });

  test("changes when the action path, reserve or ceiling changes", () => {
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, voteAction: "skip-below-threshold" }),
    );
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, voteAction: "top-up", willTopUpVote: true }),
    );
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, voteReserveLamports: "4000000000" }),
    );
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, approvedTopUpCeilingLamports: "1" }),
    );
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, approvedCeilingLamports: "10000000001" }),
    );
  });
});

describe("transaction parsing", () => {
  test("extracts a Solana CLI withdrawal signature", () => {
    const signature = "5j9QC8kioszuzC3YBXaUoJ41QGist8VPkAnD1m9kudqFpbUByKMEEMa7fwmrJaCNBkUBx4VQNRNUgwn2mCd3DyqD";
    expect(parseWithdrawalSignature(`Signature: ${signature}\n`)).toBe(signature);
  });

  test("matches a successful FundBond transaction and stake account", () => {
    const result = matchFundingTransaction(
      {
        slot: 123,
        blockTime: 456,
        meta: {
          err: null,
          fee: 15_002,
          logMessages: ["Program log: Instruction: FundBond"],
          postBalances: [26_858_640, 5_001_000_000, 1],
        },
        transaction: {
          message: {
            accountKeys: [{ pubkey: "vote" }, { pubkey: "identity" }, { pubkey: "bond" }],
            instructions: [
              {
                program: "system",
                parsed: {
                  type: "createAccount",
                  info: {
                    source: "identity",
                    newAccount: "stake",
                    lamports: 9_964_279_320,
                  },
                },
              },
            ],
          },
        },
      },
      { vote: "vote", identity: "identity", bond: "bond", amountLamports: 9_964_279_320n },
    );
    // The identity post-balance is the basis for the hard-floor check.
    expect(result).toEqual({
      stakeAccount: "stake", blockTime: 456, slot: 123, feeLamports: 15_002, identityPostBalanceLamports: 5_001_000_000,
    });
  });
});

test('funding verification rejects failed, unrelated and wrong-amount transactions',()=>{
 const expected={vote:'vote',identity:'identity',bond:'bond',amountLamports:100n};
 const transaction={slot:1,blockTime:1,meta:{err:null as unknown,fee:1,logMessages:['Program log: Instruction: FundBond']},transaction:{message:{accountKeys:['vote','identity','bond'],instructions:[{program:'system',parsed:{type:'createAccount',info:{source:'identity',newAccount:'stake',lamports:100}}}]}}};
 expect(matchFundingTransaction(transaction,expected)?.stakeAccount).toBe('stake');
 expect(matchFundingTransaction(transaction,expected)?.identityPostBalanceLamports).toBeNull();
 expect(matchFundingTransaction({...transaction,meta:{...transaction.meta,err:{InstructionError:[0,'error']}}},expected)).toBeUndefined();
 expect(matchFundingTransaction(transaction,{...expected,amountLamports:101n})).toBeUndefined();
 expect(matchFundingTransaction(transaction,{...expected,bond:'different-bond'})).toBeUndefined();
 expect(matchFundingTransaction({...transaction,meta:{...transaction.meta,logMessages:[]}},expected)).toBeUndefined();
});
