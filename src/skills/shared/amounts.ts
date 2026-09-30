export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Approximate SOL conversion for reports; transaction amounts stay in bigint. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

/** Exact SOL formatting for plans and transaction amounts; never round through Number. */
export function formatSol(lamports: bigint): string {
  const sign = lamports < 0n ? '-' : '';
  const absolute = lamports < 0n ? -lamports : lamports;
  return `${sign}${absolute / LAMPORTS_PER_SOL}.${(absolute % LAMPORTS_PER_SOL).toString().padStart(9, '0')}`;
}
