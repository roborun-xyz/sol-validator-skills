import { TransportError } from "../../shared/http";
import { rpcCall } from "../../shared/operator-config";

/**
 * DoubleZero 2Z token rewards received by the validator identity, attributed by receipt epoch:
 * the epoch containing the slot of the transaction that credited the identity's 2Z account.
 * Amounts come from pre/post token balances, never from logs. Logs and memos only label the
 * reward period for reconciliation. 2Z is reported in token units and never added to SOL
 * revenue: no verified historical 2Z/SOL price source is used.
 */
export const DOUBLEZERO_2Z_MINT = "J6pQQ3FAcJQeWPPGppWRb4nM8jU3wLyYbRrLh7feMfvd";
/** Solana publisher rewards; logs `Distributed <raw> <mint> to <identity> ... for <YYYY-M>`. */
export const DOUBLEZERO_PUBLISHER_PROGRAM = "J9gupbyffs4XAoKn5NrJ4hrbdqW5ZfvMDaaas3FtH8yC";
/** Shred oracle validator rewards; memo `dz-shred-oracle: distribute_validator_rewards epoch=N sub_epoch=M`. */
export const DOUBLEZERO_SHRED_ORACLE_PROGRAM = "dzshrr3yL57SB13sJPYHYo3TV8Bo1i1FxkyrZr3bKNE";
export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

const SIGNATURE_PAGE_LIMIT = 1000;
const TRANSACTION_BATCH = 8;

export type DoubleZeroSource = "publisher" | "shredOracle";
export type DoubleZeroStatus = "none" | "received" | "unavailable";

export type DoubleZeroTransfer = {
  signature: string;
  slot: number;
  epoch: number;
  blockTime: number | null;
  /** Distributor that credited the tokens, or `unclassified` for any other 2Z balance change. */
  source: DoubleZeroSource | "unclassified";
  /** Signed net change of identity-owned 2Z balances, in raw token units. */
  amountRaw: string;
  /** Reward period parsed from logs/memo (publisher `YYYY-M`, shred oracle `epoch=N sub_epoch=M`). */
  labels: string[];
};

export type DoubleZeroSourceTotals = {
  amountRaw: string;
  txCount: number;
  labels: string[];
};

export type DoubleZeroEpoch = {
  epoch: number;
  status: DoubleZeroStatus;
  receivedRaw: bigint;
  publisherRaw: bigint;
  shredOracleRaw: bigint;
  publisherTxCount: number;
  shredOracleTxCount: number;
  publisherLabels: string[];
  shredOracleLabels: string[];
  unclassifiedInflowRaw: bigint;
  unclassifiedOutflowRaw: bigint;
  transfers: DoubleZeroTransfer[];
};

export type DoubleZeroReport = {
  mint: string;
  decimals: number | null;
  identities: string[];
  tokenAccounts: string[];
  programs: Record<DoubleZeroSource, string>;
  firstSlot: number | null;
  endSlotExclusive: number | null;
  /** Null when the scan completed; otherwise every epoch is `unavailable`. */
  error: string | null;
  epochs: Map<number, DoubleZeroEpoch>;
};

export type DoubleZeroRpc = <T = any>(method: string, params?: unknown) => Promise<T>;

type EpochSchedule = { slotsPerEpoch: number; firstNormalEpoch: number; firstNormalSlot: number };

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

type ParsedTransaction = {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: Array<{ instructions: Array<{ programId?: string }> }> | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<string | { pubkey: string }>;
      instructions: Array<{ programId?: string }>;
    };
  };
};

/** Bounded retries for read-only RPC; provider bodies and URLs stay out of errors. */
export function retryingRpc(rpcUrl: string, retries = 4, baseDelayMs = 500): DoubleZeroRpc {
  return async <T>(method: string, params: unknown = []): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rpcCall<T>(rpcUrl, method, params);
      } catch (error) {
        if (!(error instanceof TransportError) || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  };
}

export function epochFirstSlot(epoch: number, schedule: EpochSchedule): number {
  if (epoch < schedule.firstNormalEpoch) throw new Error(`Cannot derive slots for warmup epoch ${epoch}.`);
  return schedule.firstNormalSlot + (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch;
}

export function epochForSlot(slot: number, schedule: EpochSchedule): number {
  if (slot < schedule.firstNormalSlot) throw new Error(`Slot ${slot} is in the warmup period.`);
  return schedule.firstNormalEpoch + Math.floor((slot - schedule.firstNormalSlot) / schedule.slotsPerEpoch);
}

/** Exact decimal string for raw token units; never rounds through Number. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  if (decimals === 0) return `${sign}${absolute}`;
  const scale = 10n ** BigInt(decimals);
  return `${sign}${absolute / scale}.${(absolute % scale).toString().padStart(decimals, "0")}`;
}

function invokedPrograms(tx: ParsedTransaction): Set<string> {
  const programs = new Set<string>();
  for (const ix of tx.transaction.message.instructions) if (ix.programId) programs.add(ix.programId);
  for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) if (ix.programId) programs.add(ix.programId);
  for (const line of tx.meta?.logMessages ?? []) {
    const match = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (match) programs.add(match[1]);
  }
  return programs;
}

function accountKey(tx: ParsedTransaction, index: number): string | undefined {
  const key = tx.transaction.message.accountKeys[index];
  return typeof key === "string" ? key : key?.pubkey;
}

/**
 * Signed net change of the identity-owned 2Z balances in one transaction, from token balances.
 * A balance belongs to the identity when its owner is one of the identities or its account is one
 * of the identity's known 2Z token accounts. A missing pre or post entry counts as zero.
 */
export function identityTokenDelta(
  tx: ParsedTransaction, owners: ReadonlySet<string>, tokenAccounts: ReadonlySet<string>, mint = DOUBLEZERO_2Z_MINT,
): bigint {
  const sum = (balances: TokenBalance[] | null | undefined) => (balances ?? []).reduce((total, balance) => {
    if (balance.mint !== mint) return total;
    const account = accountKey(tx, balance.accountIndex);
    if (!(balance.owner && owners.has(balance.owner)) && !(account && tokenAccounts.has(account))) return total;
    if (!/^\d+$/.test(balance.uiTokenAmount?.amount ?? "")) throw new Error("Invalid token balance amount.");
    return total + BigInt(balance.uiTokenAmount.amount);
  }, 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** Reward-period labels from the distributor's logs or memo; labels never set amounts. */
export function rewardLabels(tx: ParsedTransaction, source: DoubleZeroSource, owners: ReadonlySet<string>, mint = DOUBLEZERO_2Z_MINT): string[] {
  const labels = new Set<string>();
  for (const line of tx.meta?.logMessages ?? []) {
    if (source === "publisher") {
      const match = /^Program log: Distributed (\d+) (\S+) to (\S+) for leaf \d+ of feed \S+ for (\d{4}-\d{1,2})$/.exec(line);
      if (match && match[2] === mint && owners.has(match[3])) labels.add(match[4]);
    } else {
      const match = /dz-shred-oracle: distribute_validator_rewards (epoch=\d+ sub_epoch=\d+)/.exec(line);
      if (match) labels.add(match[1]);
    }
  }
  return [...labels];
}

/**
 * Classifies one transaction: a 2Z credit to the identity in a transaction that invokes exactly one
 * known distributor is a reward from that source. Every other identity 2Z balance change, including
 * a debit inside a distributor transaction, is unclassified and reported separately.
 */
export function classifyTransaction(
  tx: ParsedTransaction, owners: ReadonlySet<string>, tokenAccounts: ReadonlySet<string>, mint = DOUBLEZERO_2Z_MINT,
): { source: DoubleZeroSource | "unclassified" | null; delta: bigint; labels: string[] } {
  const delta = identityTokenDelta(tx, owners, tokenAccounts, mint);
  const programs = invokedPrograms(tx);
  const publisher = programs.has(DOUBLEZERO_PUBLISHER_PROGRAM);
  const shredOracle = programs.has(DOUBLEZERO_SHRED_ORACLE_PROGRAM);
  const source: DoubleZeroSource | null = publisher !== shredOracle ? (publisher ? "publisher" : "shredOracle") : null;
  if (source && delta >= 0n) return { source, delta, labels: rewardLabels(tx, source, owners, mint) };
  if (delta === 0n) return { source: null, delta, labels: [] };
  return { source: "unclassified", delta, labels: [] };
}

export function emptyDoubleZeroEpoch(epoch: number, status: DoubleZeroStatus): DoubleZeroEpoch {
  return {
    epoch, status, receivedRaw: 0n, publisherRaw: 0n, shredOracleRaw: 0n, publisherTxCount: 0, shredOracleTxCount: 0,
    publisherLabels: [], shredOracleLabels: [], unclassifiedInflowRaw: 0n, unclassifiedOutflowRaw: 0n, transfers: [],
  };
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) results.push(...await Promise.all(items.slice(offset, offset + size).map(run)));
  return results;
}

/** Signatures touching `address` with slot in [firstSlot, endSlot); stops paginating once before the window. */
export async function signaturesInWindow(
  rpc: DoubleZeroRpc, address: string, firstSlot: number, endSlot: number,
): Promise<Array<{ signature: string; slot: number; err: unknown }>> {
  const found: Array<{ signature: string; slot: number; err: unknown }> = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc<Array<{ signature: string; slot: number; err: unknown }>>("getSignaturesForAddress", [
      address, { limit: SIGNATURE_PAGE_LIMIT, commitment: "finalized", ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(page)) throw new Error("Invalid getSignaturesForAddress response.");
    for (const entry of page) if (entry.slot >= firstSlot && entry.slot < endSlot) found.push(entry);
    const last = page.at(-1);
    if (page.length < SIGNATURE_PAGE_LIMIT || !last || last.slot < firstSlot) return found;
    before = last.signature;
  }
}

/**
 * Scans the identities' 2Z token accounts (both token programs) for transactions in the epoch
 * window. Any RPC failure after bounded retries marks the whole window `unavailable` rather than
 * reporting a partial scan as zero.
 */
export async function fetchDoubleZeroRewards(
  rpc: DoubleZeroRpc, identities: string[], firstEpoch: number, lastEpoch: number, mint = DOUBLEZERO_2Z_MINT,
): Promise<DoubleZeroReport> {
  const epochs = Array.from({ length: lastEpoch - firstEpoch + 1 }, (_, index) => firstEpoch + index);
  const owners = [...new Set(identities)].sort();
  const report: DoubleZeroReport = {
    mint, decimals: null, identities: owners, tokenAccounts: [],
    programs: { publisher: DOUBLEZERO_PUBLISHER_PROGRAM, shredOracle: DOUBLEZERO_SHRED_ORACLE_PROGRAM },
    firstSlot: null, endSlotExclusive: null, error: null, epochs: new Map(),
  };
  try {
    const mintAccount = await rpc<{ value: any }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }]);
    const decimals = mintAccount?.value?.data?.parsed?.info?.decimals;
    if (!TOKEN_PROGRAMS.includes(mintAccount?.value?.owner) || mintAccount?.value?.data?.parsed?.type !== "mint" || !Number.isSafeInteger(decimals)) {
      throw new Error("2Z mint account is missing or not a token mint.");
    }
    report.decimals = decimals;
    const schedule = await rpc<EpochSchedule>("getEpochSchedule");
    const firstSlot = epochFirstSlot(firstEpoch, schedule);
    const endSlot = epochFirstSlot(lastEpoch + 1, schedule);
    report.firstSlot = firstSlot;
    report.endSlotExclusive = endSlot;

    const tokenAccounts = new Set<string>();
    for (const owner of owners) {
      for (const programId of TOKEN_PROGRAMS) {
        const response = await rpc<{ value: Array<{ pubkey: string; account: any }> }>("getTokenAccountsByOwner", [
          owner, { programId }, { encoding: "jsonParsed", commitment: "finalized" },
        ]);
        if (!Array.isArray(response?.value)) throw new Error("Invalid getTokenAccountsByOwner response.");
        for (const entry of response.value) if (entry.account?.data?.parsed?.info?.mint === mint) tokenAccounts.add(entry.pubkey);
      }
    }
    report.tokenAccounts = [...tokenAccounts].sort();

    const signatures = new Map<string, number>();
    for (const account of report.tokenAccounts) {
      for (const entry of await signaturesInWindow(rpc, account, firstSlot, endSlot)) {
        if (entry.err === null || entry.err === undefined) signatures.set(entry.signature, entry.slot);
      }
    }
    const ownerSet = new Set(owners);
    const transfers = (await inBatches([...signatures.keys()], TRANSACTION_BATCH, async (signature) => {
      const tx = await rpc<ParsedTransaction | null>("getTransaction", [
        signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" },
      ]);
      if (!tx?.meta) throw new Error("A 2Z transaction in the window was unavailable.");
      if (tx.meta.err !== null && tx.meta.err !== undefined) return null;
      const result = classifyTransaction(tx, ownerSet, tokenAccounts, mint);
      if (!result.source) return null;
      return {
        signature, slot: tx.slot, epoch: epochForSlot(tx.slot, schedule), blockTime: tx.blockTime ?? null,
        source: result.source, amountRaw: result.delta.toString(), labels: result.labels,
      } satisfies DoubleZeroTransfer;
    })).filter((transfer): transfer is DoubleZeroTransfer => transfer !== null)
      .sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
    report.epochs = aggregateDoubleZero(epochs, transfers);
  } catch (error) {
    report.error = error instanceof Error ? error.message : "DoubleZero 2Z scan failed.";
    report.epochs = new Map(epochs.map((epoch) => [epoch, emptyDoubleZeroEpoch(epoch, "unavailable")]));
  }
  return report;
}

export function aggregateDoubleZero(epochs: number[], transfers: DoubleZeroTransfer[]): Map<number, DoubleZeroEpoch> {
  const result = new Map(epochs.map((epoch) => [epoch, emptyDoubleZeroEpoch(epoch, "none")]));
  for (const transfer of transfers) {
    const row = result.get(transfer.epoch);
    if (!row) continue;
    const amount = BigInt(transfer.amountRaw);
    row.transfers.push(transfer);
    if (transfer.source === "unclassified") {
      if (amount > 0n) row.unclassifiedInflowRaw += amount;
      else row.unclassifiedOutflowRaw += -amount;
      continue;
    }
    const labels = transfer.source === "publisher" ? row.publisherLabels : row.shredOracleLabels;
    for (const label of transfer.labels) if (!labels.includes(label)) labels.push(label);
    if (transfer.source === "publisher") { row.publisherRaw += amount; row.publisherTxCount++; }
    else { row.shredOracleRaw += amount; row.shredOracleTxCount++; }
    row.receivedRaw += amount;
  }
  for (const row of result.values()) if (row.receivedRaw > 0n) row.status = "received";
  return result;
}
