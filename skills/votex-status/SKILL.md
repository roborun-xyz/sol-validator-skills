---
name: votex-status
description: Fetch current or historical Votex/The Vault vote-buy status, including target epoch, USDC bids, bid share, acquired veV when published, and on-chain IncreaseVoteBuy fallback transactions. Use for Vault/Votex epoch and allocation questions.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and Helius mainnet RPC.
metadata:
  created: "2026-05-31"
  last_updated: "2026-09-30"
---

# Votex Status

Read [installed bundle and configuration](references/shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply [RPC setup and selection](references/shared-runtime.md#discover-operator-configuration); repair missing URLs through [onboarding](references/onboarding.md), then resume the requested task. No RPC credential is bundled.

Run from the resolved bundle root:

```bash
bun src/skills/votex-status/scripts/votex_status.ts <epoch|current>
```

Options: `--epoch-only`, `--json`, `--no-names`, and `--max-pages=N`.

For `current`, read the Vault gaugemeister; the active vote-buy target is `currentRewardsEpoch + 1`. Do not infer it from wall time.

Use VotaFi `tribeca-stats` first. On HTTP 404, scan the epoch window for matching on-chain `IncreaseVoteBuy` transactions. The fallback reports bids/share but cannot calculate acquired veV. No stats and no transactions is a valid zero-bid state.

Report source type, UTC/local epoch window, total bids, sorted rows, and whether veV is unavailable.
