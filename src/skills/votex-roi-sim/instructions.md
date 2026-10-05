---
name: votex-roi-sim
description: Simulate Votex/The Vault vote-buy ROI for a validator gauge, including bid dilution, acquired veV, gauge-directed SOL, optional SFDP match, revenue, net profit, ROI, and break-even sizing. Use when comparing Votex bid amounts or estimating revenue from gauge-directed stake.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-06-01"
  last_updated: "2026-10-03"
---

# Votex ROI Simulation

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply [RPC setup and selection](../shared/runtime.md#discover-operator-configuration); repair missing URLs through [onboarding](../onboarding/instructions.md), then resume the requested task. No RPC credential is bundled.

Model allocation as bid share:

```text
acquiredVev = totalVev * bid / (otherBids + bid)
directedSol = acquiredVev * gaugeDirectedSol / totalEpochGaugeVev
revenueSol = directedSol * matchMultiplier * lamportsPerStakedSol / 1e9
roiPct = (revenueSol * solUsd - bid) / bid * 100
```

Run:

```bash
bun src/skills/votex-roi-sim/scripts/simulate.ts \
  --epoch current \
  --gauge <YOUR_GAUGE_PUBKEY> \
  --bids 10,20,50,100 \
  --match-multiplier 1
```

`--gauge` is required; there is no default validator gauge.

Useful overrides: `--current-bid`, `--other-bids`, `--total-vev`, `--total-gauge-vev`, `--lamports-per-staked-sol`, `--sol-usd`, and `--format json`.

`--lamports-per-staked-sol` defaults to `105000`, a fixed assumption for revenue per directed staked SOL over the modeled period, not a measured value. Revenue and ROI scale linearly with it, so supply the validator's own measured figure when one is available and always report which value was used.

The helper reads VotaFi stats, SolanaVault stakebot data, Jupiter SOL/USD, and Helius RPC. If active-epoch stats are unpublished, use only a user-approved comparable epoch or explicit overrides.

Report inputs, sources, assumptions, and a bid comparison range. Treat results as estimates and recompute near the bidding deadline.

The script validates that the supplied gauge is active and belongs to The Vault. Invalid/duplicate options, nonpositive bids, nonfinite values and zero gauge-veV denominators fail rather than producing partial or null results. A selected historical epoch still uses the latest stakebot stake pool and current SOL price unless manually overridden; report this mixed-time scope explicitly. The constant match multiplier does not model SFDP caps or marginal eligibility. Use `1` unless a justified effective multiplier applies to the whole modeled allocation.
