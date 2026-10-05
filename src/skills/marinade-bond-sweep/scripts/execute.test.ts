import { describe, expect, test } from "bun:test";

import {
  approvalFingerprint,
  calculateFundingAfterVote,
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

  test("recalculates an above-reserve identity after vote withdrawal", () => {
    expect(
      calculateFundingAfterVote(
        { identityAction: "fund-bond", voteTransferLamports: "4629251536" },
        14_967_009_320n,
      ),
    ).toBe(9_966_009_320n);
  });

  test("does not consume an initially below-target identity", () => {
    expect(
      calculateFundingAfterVote(
        { identityAction: "skip-below-threshold", voteTransferLamports: "1972925600" },
        5_972_925_600n,
      ),
    ).toBe(1_972_925_600n);
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
    voteAction: "withdraw-all" as const,
    willFundBond: true,
    approvedCeilingLamports: "10000000000",
  };

  test("is deterministic for the approved non-balance state", () => {
    expect(approvalFingerprint(approvedState)).toBe(approvalFingerprint({ ...approvedState }));
  });

  test("changes when the action path or ceiling changes", () => {
    expect(approvalFingerprint(approvedState)).not.toBe(
      approvalFingerprint({ ...approvedState, voteAction: "skip-below-threshold" }),
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
