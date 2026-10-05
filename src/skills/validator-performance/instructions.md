---
name: validator-performance
description: Fetch Solana validator consensus performance by epoch, including vote credits and percent of max, rank, skip rate, block production, stake, commission, MEV commission, and current delinquency. Use for validator performance reviews; default to the last 30 completed mainnet epochs.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-05-28"
  last_updated: "2026-10-05"
---

# Validator Performance

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Run from the resolved bundle root:

```bash
bun src/skills/validator-performance/scripts/performance.ts \
  --vote-account <VOTE_ACCOUNT> \
  --epochs 30
```

Use `--validator <VOTE_OR_IDENTITY>` to resolve a current identity through Helius. Add `--include-current` only when in-progress data is requested. Output formats: `markdown`, `csv`, or `json`.

The helper uses the operator-selected Helius mainnet RPC for current epoch/vote state and JPool/SVT for historical epoch metrics. Apply the shared RPC selection policy in the runtime reference. No credential is bundled.

Report current state, completed epoch range, per-epoch metrics, totals/averages, and any unavailable epochs. Use `validator-revenue` when the question is about SOL earned.

When JPool/SVT history starts after the requested first epoch, the helper shortens the window to the available epochs and states which requested epochs are unavailable (`requestedFirstEpoch` and `firstEpoch` in JSON; standard error for CSV). Repeat that scope whenever quoting totals. A gap after the first available epoch, or a missing latest epoch, still fails rather than producing a partial window.

With `--include-current`, the in-progress epoch is listed and marked, but upstream publishes partial or placeholder values for it, so it is excluded from window totals and averages. It is marked in every format: `inProgressEpoch` and a per-row `inProgress` in JSON, and an `in_progress` column in CSV. Its zero vote credits and leader slots are upstream placeholders and are reported as unavailable, not as zero. Do not read its row as a completed result. A window with no completed epoch has no totals.

Skip rate and block production come only from leader-slot counts and are unavailable for an epoch without leader slots. JPool/SVT's `skippedSlots` field is the vote-credit shortfall, not a block skip rate, and is never used as one.

## Local profiles and first use

Read [chain profile selection and first use](../onboarding/references/profiles.md#chain-query-first-use). Use `--profile NAME` and optional `--config PATH` to reuse setup; resolve missing configuration through [onboarding](../onboarding/instructions.md), then resume this check.
