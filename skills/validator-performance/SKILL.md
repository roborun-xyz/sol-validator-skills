---
name: validator-performance
description: Fetch Solana validator consensus performance by epoch, including vote credits and percent of max, rank, skip rate, block production, stake, commission, MEV commission, and current delinquency. Use for validator performance reviews; default to the last 30 completed mainnet epochs.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and a mainnet RPC URL.
metadata:
  created: "2026-05-28"
  last_updated: "2026-10-24"
---

# Validator Performance

Read [installed bundle and configuration](references/shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Run from the resolved bundle root:

```bash
bun src/skills/validator-performance/scripts/performance.ts \
  --vote-account <VOTE_ACCOUNT> \
  --epochs 30
```

Use `--validator <VOTE_OR_IDENTITY>` to resolve a current identity through the configured RPC. Add `--include-current` only when in-progress data is requested. Output formats: `markdown`, `csv`, or `json`.

The helper uses the operator-selected mainnet RPC for current epoch/vote state and JPool/SVT for historical epoch metrics. Apply the shared RPC selection policy in the runtime reference. No credential is bundled.

Report current state, completed epoch range, per-epoch metrics, totals/averages, and any unavailable epochs. Use `validator-revenue` when the question is about SOL earned.

When JPool/SVT returns no rows for the first requested epochs, the helper shortens the window to the available epochs and states which requested epochs are unavailable (`requestedFirstEpoch` and `firstEpoch` in JSON; standard error for CSV). Repeat that scope whenever quoting totals. The helper cannot tell a validator that started later from rows missing upstream, so do not describe the first available epoch as the validator's first epoch without another source. A gap after the first available epoch, or a missing latest epoch, still fails rather than producing a partial window.

With `--include-current`, the in-progress epoch is listed and marked, but upstream publishes partial or placeholder values for it, so it is excluded from window totals and averages. It is marked in every format: `inProgressEpoch` and a per-row `inProgress` in JSON, and an `in_progress` column in CSV. Its zero vote credits, leader slots and MEV commission are upstream placeholders and are reported as unavailable, not as zero. Do not read its row as a completed result. A window with no completed epoch has no totals.

## Alpenglow credits (from epoch 1064)

Mainnet switched from TowerBFT to Alpenglow in epoch 1064 (migration slot 459,653,000). Every row carries `creditScale` (`credit_scale` in CSV, Credit Scale in Markdown): `towerbft` before 1064, `alpenglow` from 1064.

- TowerBFT epochs: TVC % is credits / (slots × 16) and TVC Rank is JPool/SVT `tvcRank`, unchanged.
- Alpenglow epochs: vote credits are lamports of nominal vote reward, not vote counts. Agave credits a voter half of `epochInflation × stake / (slotsPerEpoch × totalStake)` for each slot whose reward certificate includes it, and credits the leader that includes the certificate the other half for every included voter. Credits therefore scale with stake, epoch inflation and leader slots, so raw credits rank stake, not performance. TVC % is JPool/SVT `creditsRatio` (credits / that epoch's maximum) and TVC Rank is JPool/SVT `tvcRank`, which ranks `creditsRatio` across the cluster. Both are unavailable (— / null) while the ratio is unpublished, including the in-progress epoch.
- Epoch 1064 is a migration epoch: its credits also include about 5,000 slots of TowerBFT credits and its ratio is approximate.

Never sum, average or compare credits or TVC % across the two scales. The window summary reports credit totals and TVC % averages separately for each scale, with its epoch range; block production, skip rate and commission averages still cover the whole completed window. Quote the scale and range with every credit figure.

Skip rate and block production come only from leader-slot counts and are unavailable for an epoch without leader slots. JPool/SVT's `skippedSlots` field is the vote-credit shortfall, not a block skip rate, and is never used as one.

## Local profiles and first use

Read [chain profile selection and first use](references/onboarding-references-profiles.md#chain-query-first-use). Use `--profile NAME` and optional `--config PATH` to reuse setup; resolve missing configuration through [onboarding](references/onboarding.md), then resume this check.
