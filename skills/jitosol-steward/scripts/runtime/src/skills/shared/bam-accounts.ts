import { PublicKey } from "@solana/web3.js";

export type RpcAccount = { data: [string, string]; owner: string };
export const BAM_BOOST_PROGRAM = new PublicKey("BoostxbPp2ENYHGcTLYt1obpcY13HE4NojdqNWdzqSSb");
export const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const BAM_MERKLE_BASE = 'https://storage.googleapis.com/jito-bam-boost/mainnet';
export const JITOSOL_RATIO_URL = 'https://kobe.mainnet.jito.network/api/v1/jitosol_sol_ratio';

export function deriveAssociatedJitoSolAddress(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), JITOSOL_MINT.toBuffer()], ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

export function deriveBamBoostAddresses(identity: PublicKey, claimEpoch: number) {
  if (!Number.isSafeInteger(claimEpoch) || claimEpoch < 0) throw new Error('Invalid BAM claim epoch.');
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(BigInt(claimEpoch));
  const distributor = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_distributor'), JITOSOL_MINT.toBuffer(), epoch], BAM_BOOST_PROGRAM,
  )[0];
  const claimStatus = PublicKey.findProgramAddressSync(
    [Buffer.from('claim_status'), identity.toBuffer(), distributor.toBuffer()], BAM_BOOST_PROGRAM,
  )[0];
  return {distributor, claimStatus, distributorTokenAccount:deriveAssociatedJitoSolAddress(distributor)};
}

export function deriveBamBoostClaimStatusAddress(identityAccount: string, claimEpoch: number): string {
  return deriveBamBoostAddresses(new PublicKey(identityAccount), claimEpoch).claimStatus.toBase58();
}

const BAM_BOOST_CLAIM_STATUS_ACCOUNT_SIZE = 48;
const BAM_BOOST_CLAIM_STATUS_DISCRIMINATOR = Buffer.from([22, 183, 249, 157, 247, 95, 150, 96]);

export function verifyBamBoostClaimStatusAccount(
  account: RpcAccount,
  identityAccount: string,
  expectedAmount: bigint,
): void {
  if (account.owner !== BAM_BOOST_PROGRAM.toBase58()) {
    throw new Error(
      `BAM Boost Claim Status account has unexpected owner ${account.owner}.`,
    );
  }
  if (account.data[1] !== "base64") {
    throw new Error(
      `BAM Boost Claim Status account used unexpected encoding '${account.data[1]}'.`,
    );
  }

  const data = Buffer.from(account.data[0], "base64");
  if (data.length !== BAM_BOOST_CLAIM_STATUS_ACCOUNT_SIZE) {
    throw new Error(
      `BAM Boost Claim Status account has unexpected size ${data.length}.`,
    );
  }
  if (
    !data
      .subarray(0, BAM_BOOST_CLAIM_STATUS_DISCRIMINATOR.length)
      .equals(BAM_BOOST_CLAIM_STATUS_DISCRIMINATOR)
  ) {
    throw new Error("BAM Boost Claim Status discriminator did not match.");
  }

  const identity = new PublicKey(identityAccount);
  if (!data.subarray(8, 40).equals(identity.toBuffer())) {
    throw new Error("BAM Boost Claim Status claimant did not match.");
  }
  const claimedAmount = data.readBigUInt64LE(40);
  if (claimedAmount !== expectedAmount) {
    throw new Error(
      `BAM Boost Claim Status amount ${claimedAmount} did not match allocation ${expectedAmount}.`,
    );
  }
}
