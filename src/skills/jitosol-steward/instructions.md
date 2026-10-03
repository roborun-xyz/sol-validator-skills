---
name: jitosol-steward
description: Check current JitoSOL Steward validator ranking, algorithmic delegation fraction, active/transient stake, instant unstake and scoring cycle on Solana mainnet. Use for JitoSOL rank or delegation-set comparisons, not ordinary Jito MEV or BAM rewards.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-10-03"
  last_updated: "2026-10-03"
---

# JitoSOL Steward

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded skill, not the session working directory. Install dependencies with `bun install --frozen-lockfile` from the resolved bundle root when `node_modules` is absent.

Run this read-only check from the bundle root:

```bash
bun src/skills/jitosol-steward/scripts/check.ts --profile my-validator --format markdown
```

Use `--vote-account PUBKEY` for an explicit vote account or `--validator PUBKEY` for vote/identity resolution. `--config PATH` and `--rpc URL` follow shared Helius precedence. Resolve missing profile/RPC setup through [onboarding](../onboarding/instructions.md), then resume. SSH and signers are unnecessary.

Add `--pool-summary` to compare all positive algorithmic target fractions against `1 / current member count` and show the five largest actual active-stake balances. Use `--format json` for complete addresses, exact lamports and comparable records.

Report UTC and Asia/Shanghai check times, finalized snapshot slot, current/state epoch, **Overall Rank** and scored count, score, delegation numerator/denominator, active/transient stake, stake-list update epoch, instant-unstake flag and next cycle epoch. Overall Rank is the **1-based position in the on-chain descending score index across all scored validators**, including zero scores; tied scores retain on-chain order. It is not the rank among only eligible or delegated validators. Newly added validators and incomplete scoring cycles have an unavailable rank, never rank zero. A validator absent from the list is `not_in_pool`, not a failed chain query.

Keep algorithmic target fractions separate from actual stake. Nonmembers have numerator zero (some unused denominators may be zero). Directed stake, deposits, and rebalance timing can make actual stake differ from algorithmic targets; this helper does not decode directed stake and cannot attribute excess balances to it. SPL list balances are observations at `lastUpdateEpoch`, not direct stake-account queries. Rank and next cycle do not guarantee future stake or admission.

The helper checks mainnet genesis and live vote/identity, then verifies the config/state owners and Anchor discriminators, derived state PDA, SPL pool/list owners and links, V2 size, index uniqueness/order and positive fractions. Config/state/list/pool are read together at finalized commitment. Unsupported layouts or failed checks stop the query; do not replace missing data with zero or bypass validation.

## Decoder source

Layout and ranking semantics were reviewed against Jito's [Steward V2 state](https://github.com/jito-foundation/stakenet/blob/9d04233e1b19f3ab7e510f950f7cef8fd470884c/programs/steward/src/state/steward_state.rs), [accounts](https://github.com/jito-foundation/stakenet/blob/9d04233e1b19f3ab7e510f950f7cef8fd470884c/programs/steward/src/state/accounts.rs) and [timing reference](https://github.com/jito-foundation/stakenet/blob/9d04233e1b19f3ab7e510f950f7cef8fd470884c/agent-guides/jitosol-stake-timing-reference.md). The SPL list uses a 9-byte header and 73-byte entries; the pool validator-list pubkey begins at byte 98 per the [SPL StakePool struct](https://github.com/solana-program/stake-pool/blob/7a9b4cd5216e1d3e764ea001d19cbdd7a9a04b87/program/src/state.rs). The timing reference's pool offsets disagree with that struct and the validated live account; use the helper's checked links rather than copying those pool offsets.
