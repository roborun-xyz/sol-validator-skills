---
name: votex-roi-sim
description: Simulate Votex/The Vault vote-buy ROI for a validator gauge, including bid dilution, acquired veV, gauge-directed SOL, optional SFDP match, per-epoch revenue over a hold period, net profit, ROI, best-net bid and break-even sizing, plus gauge lookup by validator name. Use when comparing Votex bid amounts, estimating revenue from gauge-directed stake, or finding a validator's Vault gauge.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and a mainnet RPC URL. `--find-gauge` needs an endpoint with DAS `getAssetBatch` coverage (Helius does).
metadata:
  created: "2026-06-01"
  last_updated: "2026-10-27"
---

# Votex ROI Simulation

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply [RPC setup and selection](../shared/runtime.md#discover-operator-configuration); repair missing URLs through [onboarding](../onboarding/instructions.md), then resume the requested task. No RPC credential is bundled.

## Find the gauge

`--gauge` is required; there is no default validator gauge. No on-chain link from a vote account to its gauge is used. If the operator knows only the validator brand, look it up by the staked token's metadata name:

```bash
bun src/skills/votex-roi-sim/scripts/simulate.ts --find-gauge <NAME_SUBSTRING> [--format json]
```

It lists active Vault gauges (gauge → quarry → token mint → DAS metadata name) whose trimmed name contains the substring, case-insensitively, and exits without simulating. A match is by token metadata name only: show the gauge, quarry, mint and name and have the operator confirm before simulating. Never pick a match for the simulation yourself. An RPC without usable DAS fails; a zero-match result while some gauges lacked metadata fails as incomplete instead of meaning "no gauge".

## Model

Allocation is bid share:

```text
acquiredVev = totalVev * bid / (otherBids + bid)
directedSol = acquiredVev * gaugeDirectedSol / totalEpochGaugeVev
revenueSol = directedSol * matchMultiplier * lamportsPerStakedSol / 1e9
roiPct = (revenueSol * solUsd - bid) / bid * 100
```

Revenue is the decisive input. Prefer the per-epoch mode:

```text
lamportsPerStakedSol = revenueLamportsPerSolEpoch * holdEpochs
```

- `--revenue-lamports-per-sol-epoch`: the validator's measured gross revenue per staked SOL per Solana epoch. Run the `validator-revenue` skill over a recent window and divide its "Pre-Comp Lamports / 1k Stake" column by 1000; use the stake-weighted mean of the window. Use gross, not net: Alpenglow VAT (0.8 SOL/epoch) and other fixed costs do not grow with extra directed stake.
- `--hold-epochs`: Solana epochs the stake directed by one vote-buy epoch stays on the validator. It has no default. The Vault docs say gauge epochs last 7 days, votes in one gauge epoch set the next epoch's allocation, and stake usually moves 1 to 2 Solana epochs after the gauge boundary ([Gauge Voting Overview](https://docs.thevault.finance/community-pool/gauges), [Delegation FAQs](https://docs.thevault.finance/delegation/delegation-faqs#when-do-gauge-vote-changes-start-to-affect-my-validator)). They do not state a Solana-epoch count for Votex vote buys. One operator reported 7; confirm the value with the operator and report it as an assumption.
- `--revenue-low-lamports-per-sol-epoch`: optional low-rate scenario. Per-epoch revenue swings a lot between epochs (leader slots, fees, MEV), so report a low scenario from a weak recent epoch or a low percentile of the window.

Per-epoch mode also prints a compact sensitivity table: a hold-1 scenario (one fewer earning epoch; an activation lag that the docs do not specify) and, with a low rate, the low-rate scenarios.

`--lamports-per-staked-sol` is the legacy total over the modeled period and cannot be combined with the per-epoch flags. Its default, `105000`, is an unmeasured assumption with no stated period. Use it only when the operator supplies a justified total, and say when the default was used.

## Run

```bash
bun src/skills/votex-roi-sim/scripts/simulate.ts \
  --epoch current \
  --gauge <YOUR_GAUGE_PUBKEY> \
  --bids 10,20,50,100 \
  --revenue-lamports-per-sol-epoch <GROSS_LAMPORTS_PER_SOL_EPOCH> \
  --hold-epochs <SOLANA_EPOCHS> \
  --revenue-low-lamports-per-sol-epoch <LOW_RATE>
```

Other overrides: `--current-bid`, `--other-bids`, `--total-vev`, `--total-gauge-vev`, `--match-multiplier`, `--sol-usd`, and `--format json`.

The helper reads VotaFi stats, SolanaVault stakebot data, Jupiter SOL/USD, and the configured mainnet RPC. If active-epoch stats are unpublished, use only a user-approved comparable epoch or explicit overrides. Published stats that include a non-USDC vote buy fail the simulation; explicit overrides do not bypass that.

## Report

Report the revenue mode, per-epoch rate and hold epochs (or the legacy total and whether it was the default), other inputs, sources and the bid comparison. The output marks the bid with the highest net USD among the listed bids; it often differs from the highest-ROI bid, which tends to be the smallest. Present both, along with the low-rate and hold-1 scenarios. Treat results as estimates and recompute near the bidding deadline because other bids move.

The script validates that the supplied gauge is active and belongs to The Vault. Invalid/duplicate/mixed options, nonpositive bids, nonfinite values and zero gauge-veV denominators fail rather than producing partial or null results. A selected historical epoch still uses the latest stakebot stake pool and current SOL price unless manually overridden; report this mixed-time scope explicitly. The constant match multiplier does not model SFDP caps or marginal eligibility. Use `1` unless a justified effective multiplier applies to the whole modeled allocation.
