---
name: validator-revenue
description: Fetch Solana validator historical gross and net revenue by epoch, including voting rewards, commission rewards, Jito rewards, BAM Boost JitoSOL subsidies, voting compensation, voting fees, and Marinade bond payments when present. Use for revenue history and per-epoch income; default to the last 30 completed mainnet epochs.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-05-27"
  last_updated: "2026-09-30"
---

# Validator Revenue

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Install the workspace dependencies from the resolved bundle root with `bun install --frozen-lockfile` when `node_modules` is absent.

Run from the resolved bundle root:

```bash
bun src/skills/validator-revenue/scripts/revenue.ts \
  --vote-account <VOTE_ACCOUNT> \
  --epochs 30
```

Use `--validator <VOTE_OR_IDENTITY>` for identity resolution, `--include-current` only when requested, and `--format markdown|csv|json` for output.

The helper uses the repository Helius mainnet RPC, JPool/SVT history, Trillium epoch-specific identity resolution, Jito's official validator rewards and JitoSOL/SOL ratio APIs, Jito's public BAM Boost Merkle distributions, and Marinade's validator-bonds API.

For a Marinade bidding bond, when an epoch has no published `ValidatorBond`-funded `Bidding` events globally, estimate its pending bidding cost using that epoch's `https://scoring.marinade.finance/api/v1/scores/sam?epoch=N` row: `effectiveBid × values.marinadeActivatedStakeSol / 1000`. The API's effective bid is in SOL per 1,000 SOL per epoch and includes static/dynamic bid components; do not substitute configured CPMPE, target stake, total validator stake or another epoch's data, or add dynamic commissions a second time. Missing, duplicate, mismatched-epoch or invalid bid/stake data fails the estimate rather than becoming zero.

Keep `marinadeBondPaymentSol` as published payments and report `marinadeBondEstimatedPaymentSol` separately; deduct both from net revenue. Preserve the estimate's bid, activated stake and source URL in output and label affected net totals as provisional. Replace the estimate with published Bidding costs on subsequent queries, never add both for the same bidding obligation. Global Bidding publication is only an availability proxy: `no_record` means no matching published payment, not a verified zero liability, and publication can be partial. Auction-snapshot estimates exclude additional penalties/PSR and may differ from final settlement; existing published non-bidding costs remain included. Do not apply the SAM formula to institutional-only bonds. See [Marinade settlement rules](https://docs.marinade.finance/marinade-protocol/protocol-overview/stake-auction-market/bonds-settlements).

Calculate validator-operator Jito MEV revenue from Jito's official validator rewards as `floor(mev_revenue * mev_commission_bps / 10_000)`. Do not use JPool/SVT's raw `jitoReward` as revenue because that inflow can include returned Tip Distribution Account rent. Report the raw SVT inflow and excluded difference for reconciliation, but exclude the difference from gross and net revenue.

BAM Boost accounting follows JIP-31's epoch-lagged distribution: a subsidy earned in epoch `N` is read from claim distributor epoch `N+1`. Treat presence in Jito's Merkle tree as an allocation, not proof of receipt. Derive the official distributor and Claim Status PDAs and check them at finalized commitment through the repository Helius RPC. Mark an allocation `claimed` only when the Claim Status account exists and its owner, discriminator, claimant, and amount match; an absent Claim Status marks a positive published allocation `unclaimed`, while malformed or mismatched Claim Status data fails verification. Report allocated and claimed amounts separately in raw JitoSOL and historical SOL equivalent.

Convert allocated JitoSOL to SOL with Jito's latest official daily JitoSOL/SOL ratio at or before the first confirmed block of claim epoch `N+1`, retain the raw JitoSOL amount and rate timestamp in both UTC and Asia/Shanghai for auditability, and include the allocated SOL amount in gross and net revenue. Use that same historical rate for the claimed SOL equivalent so allocated and claimed values are comparable; claiming is a receipt-state change and must not add the reward to revenue a second time. Never assume 1 JitoSOL equals 1 SOL.

Use [JIP-31](https://forum.jito.network/t/jip-31-introduce-a-bam-early-adopter-subsidy-programme/909) for the earning-to-claim epoch convention, `https://storage.googleapis.com/jito-bam-boost/mainnet/<CLAIM_EPOCH>/merkle_tree.json` for published allocations, Jito's official [`jito-bam-boost-cli`](https://github.com/jito-foundation/jito-bam-boost-cli) for PDA and Claim Status semantics, and Jito's [`jitosol_sol_ratio`](https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/stake-pool-api/#9-jitosolsol-ratio) API for historical exchange ratios.

Report the completed epoch range, bond status, per-epoch revenue components, official Jito MEV commission, excluded SVT Jito inflows, BAM Boost allocated and claimed JitoSOL, historical allocated and claimed SOL equivalents, allocation and claim statuses, totals, missing rows, and assumptions. Use `validator-performance` for credits, rank, skip rate, and block production.

## Local profiles and first use

Read [chain profile selection and first use](../onboarding/references/profiles.md#chain-query-first-use). Use `--profile NAME` and optional `--config PATH` to reuse setup; resolve missing configuration through [onboarding](../onboarding/instructions.md), then resume this check.
