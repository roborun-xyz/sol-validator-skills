---
name: validator-performance
description: Fetch Solana validator consensus performance by epoch, including vote credits and percent of max, rank, skip rate, block production, stake, commission, MEV commission, and current delinquency. Use for validator performance reviews; default to the last 30 completed mainnet epochs.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-05-28"
  last_updated: "2026-09-30"
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

The helper uses the repository Helius mainnet RPC for current epoch/vote state and JPool/SVT for historical epoch metrics. Apply the shared RPC selection policy in the runtime reference. No credential is bundled.

Report current state, completed epoch range, per-epoch metrics, totals/averages, and any missing upstream rows. Use `validator-revenue` when the question is about SOL earned.

## Local profiles and first use

Read [chain profile selection and first use](../onboarding/references/profiles.md#chain-query-first-use). Use `--profile NAME` and optional `--config PATH` to reuse setup; resolve missing configuration through [onboarding](../onboarding/instructions.md), then resume this check.
