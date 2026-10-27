import { base58Decode, base58Encode } from "./base58";
import { GAUGE_PROGRAM, VAULT_GAUGEMEISTER } from "./votex-accounts";

/** JSON-RPC caller; transport, credentials and redaction stay with the caller. */
export type GaugeRpc = <T = any>(method: string, params?: unknown) => Promise<T>;

/** Gauge layout: discriminator(8) | gaugemeister(32) | quarry(32) | is_disabled(1). */
const GAUGE_MEISTER_OFFSET = 8;
const GAUGE_QUARRY_OFFSET = 40;
const GAUGE_DISABLED_OFFSET = 72;
/** Quarry layout used here: discriminator(8) | rewarder(32) | token mint(32). */
const QUARRY_MINT_OFFSET = 40;

export type VaultGaugeMatch = { gauge: string; quarry: string; tokenMint: string; name: string };

export class DasUnavailableError extends Error {
  constructor() {
    super("Gauge name lookup needs an RPC endpoint that serves the DAS getAssetBatch method (Helius does); this endpoint did not answer it.");
  }
}

/** Active Vault gauge: owned layout long enough, bound to The Vault gaugemeister, not disabled. */
export function isActiveVaultGauge(data: Uint8Array): boolean {
  if (data.length <= GAUGE_DISABLED_OFFSET) return false;
  const meister = base58Decode(VAULT_GAUGEMEISTER);
  const slice = data.subarray(GAUGE_MEISTER_OFFSET, GAUGE_MEISTER_OFFSET + 32);
  return slice.every((byte, i) => byte === meister[i]) && data[GAUGE_DISABLED_OFFSET] === 0;
}

export function gaugeQuarry(data: Uint8Array): string | undefined {
  return data.length >= GAUGE_QUARRY_OFFSET + 32 ? base58Encode(data.subarray(GAUGE_QUARRY_OFFSET, GAUGE_QUARRY_OFFSET + 32)) : undefined;
}

export function quarryTokenMint(data: Uint8Array): string | undefined {
  return data.length >= QUARRY_MINT_OFFSET + 32 ? base58Encode(data.subarray(QUARRY_MINT_OFFSET, QUARRY_MINT_OFFSET + 32)) : undefined;
}

/** Token metadata names may carry leading or trailing whitespace. */
export function normalizeGaugeName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

/** Case-insensitive substring match on the trimmed metadata name. An empty query is rejected. */
export function matchGaugesByName<T extends { name: string }>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("Gauge name query must not be empty");
  return entries
    .filter((entry) => normalizeGaugeName(entry.name).toLowerCase().includes(needle))
    .sort((a, b) => normalizeGaugeName(a.name).localeCompare(normalizeGaugeName(b.name)));
}

const decode = (encoded: unknown) => Buffer.from(Array.isArray(encoded) ? String(encoded[0]) : "", "base64");

/** Every active Vault gauge with its quarry. */
export async function listActiveVaultGauges(rpc: GaugeRpc): Promise<Array<{ gauge: string; quarry: string }>> {
  const accounts = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>("getProgramAccounts", [
    GAUGE_PROGRAM,
    { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: GAUGE_MEISTER_OFFSET, bytes: VAULT_GAUGEMEISTER } }] },
  ]);
  if (!Array.isArray(accounts)) throw new Error("Invalid getProgramAccounts response for Vault gauges");
  const gauges: Array<{ gauge: string; quarry: string }> = [];
  for (const { pubkey, account } of accounts) {
    const data = decode(account?.data);
    const quarry = gaugeQuarry(data);
    if (isActiveVaultGauge(data) && quarry) gauges.push({ gauge: pubkey, quarry });
  }
  return gauges;
}

/** Map quarries to their staked token mints; missing or short quarry accounts are omitted. */
export async function quarryTokenMints(rpc: GaugeRpc, quarries: string[]): Promise<Map<string, string>> {
  const mints = new Map<string, string>();
  for (let i = 0; i < quarries.length; i += 100) {
    const batch = quarries.slice(i, i + 100);
    const result = await rpc<{ value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [
      batch, { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!Array.isArray(result?.value) || result.value.length !== batch.length) throw new Error("Invalid getMultipleAccounts response for gauge quarries");
    result.value.forEach((account, j) => {
      const mint = account ? quarryTokenMint(decode(account.data)) : undefined;
      if (mint) mints.set(batch[j], mint);
    });
  }
  return mints;
}

/** DAS metadata names by mint. A failing DAS call is reported as unavailable, never as "no match". */
export async function assetNames(rpc: GaugeRpc, mints: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < mints.length; i += 1000) {
    let assets: Array<{ id?: string; content?: { metadata?: { name?: unknown } } } | null>;
    try {
      assets = await rpc("getAssetBatch", { ids: mints.slice(i, i + 1000) });
    } catch {
      throw new DasUnavailableError();
    }
    // Some endpoints accept the method but return only nulls; that is not a usable DAS answer.
    if (!Array.isArray(assets) || !assets.some((asset) => asset?.id)) throw new DasUnavailableError();
    for (const asset of assets) if (asset?.id) names.set(asset.id, normalizeGaugeName(asset.content?.metadata?.name));
  }
  return names;
}

export class IncompleteGaugeLookupError extends Error {
  constructor(unresolved: number, total: number) {
    super(`No gauge matched, but ${unresolved} of ${total} active gauges have no token metadata from this RPC; the lookup is incomplete. Use an endpoint with full DAS coverage (Helius does).`);
  }
}

/**
 * Active Vault gauges whose staked token metadata name contains the query. Identification only.
 * `unresolvedGauges` counts gauges whose quarry or asset the RPC did not return; an empty match
 * with unresolved gauges is an error, not "no gauge".
 */
export async function findVaultGaugesByName(rpc: GaugeRpc, query: string): Promise<{ activeGauges: number; unresolvedGauges: number; matches: VaultGaugeMatch[] }> {
  if (!query.trim()) throw new Error("Gauge name query must not be empty");
  const gauges = await listActiveVaultGauges(rpc);
  const mints = await quarryTokenMints(rpc, [...new Set(gauges.map((g) => g.quarry))]);
  const names = await assetNames(rpc, [...new Set(mints.values())]);
  const entries = gauges.flatMap(({ gauge, quarry }) => {
    const tokenMint = mints.get(quarry);
    return tokenMint && names.has(tokenMint) ? [{ gauge, quarry, tokenMint, name: names.get(tokenMint)! }] : [];
  });
  const unresolvedGauges = gauges.length - entries.length;
  const matches = matchGaugesByName(entries, query);
  if (!matches.length && unresolvedGauges) throw new IncompleteGaugeLookupError(unresolvedGauges, gauges.length);
  return { activeGauges: gauges.length, unresolvedGauges, matches };
}
