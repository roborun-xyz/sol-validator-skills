---
created: 2026-09-15
last_updated: 2026-10-05
---

# Local operator profiles

Default location: `~/.config/validator-ops/config.json`. Override with `VALIDATOR_OPS_CONFIG` or `--config PATH` (highest priority). Configuration version 2 supports mainnet chain-only checks. It is independent of the existing Markdown host inventory.

RPC URLs are saved per profile after verification. Apply [RPC selection](shared-runtime.md#discover-operator-configuration); invalid nonempty overrides fail rather than silently selecting another endpoint. Only Helius mainnet HTTPS endpoints are accepted, and validator resolution also checks genesis. The URL may contain an API key: keep this operator file outside the source repository and installed skill, never print it, and retain atomic writes with mode 0600. Do not run simultaneous profile updates against the same file.

```bash
# Inspect local setup without network access; prints public profile fields only.
bun src/skills/onboarding/scripts/onboard.ts status

# Verify and add a profile. No SSH or signing keys required.
bun src/skills/onboarding/scripts/onboard.ts add --profile mine --validator <PUBLIC_KEY>

# Intentionally refresh identity/RPC mapping; optionally choose the default.
bun src/skills/onboarding/scripts/onboard.ts refresh --profile mine --default

# Use a custom operator configuration location.
bun src/skills/onboarding/scripts/onboard.ts add --config /absolute/path/operator.json --profile other --validator <PUBLIC_KEY>
```

The public key may be a current vote account or identity. Mainnet `getVoteAccounts` resolves it to a unique pair, including delinquent validators. Unreachable RPC, wrong network or ambiguous/missing accounts prevents saving. Verification of a relationship is not a claim of healthy operation or SFDP eligibility.

Saved shape (illustrative public keys):

```json
{
  "version": 2,
  "defaultProfile": "mine",
  "profiles": {
    "mine": {
      "cluster": "mainnet-beta",
      "voteAccount": "REPLACE_WITH_VERIFIED_VOTE_ACCOUNT",
      "identity": "REPLACE_WITH_VERIFIED_IDENTITY",
      "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=<API_KEY>",
      "verification": { "source": "helius-rpc", "checkedAt": "2026-09-15T00:00:00Z" }
    }
  }
}
```

The placeholder public keys must be replaced through onboarding; do not copy this example as a working profile.

The example timestamp is 2026-09-15 00:00 UTC. Actual timestamps are produced by the verifier. Onboarding output includes UTC and local time; the local zone is the machine's zone (override with `LOCAL_TIME_ZONE`). A stored timestamp records the last add/refresh; scripts recheck the relationship rather than treating this as permanent verification.

## Chain query first use

Selection: explicit public key overrides saved target; `--profile` overrides default; a sole profile is auto-selected. An explicit profile with an explicit public key supplies RPC settings only, so querying another validator never rewrites the profile. Explicit account commands can reuse the default or sole profile RPC without changing their target; several profiles without a default require selection only when a saved URL is needed. Without a saved profile, use `SOLANA_RPC_URL` or `--rpc`. A malformed or explicitly missing config fails clearly instead of falling back to another operator's setup.

For missing profiles or credentials, follow [onboarding](../SKILL.md), ask only for missing fields, then resume the requested check. SSH and signing keys are unnecessary for chain queries. Ordinary query overrides never persist. Never print API keys.

Errors are actionable: `ONBOARDING_REQUIRED` means missing target or RPC settings; `PROFILE_REQUIRED` means choose a profile; `PROFILE_CONFLICT` means a saved identity no longer matches the live vote account. Refresh only after resolving the change. No saved profile authorizes a transaction, SSH command or failover.

An existing zero-stake vote account can be resolved through finalized parsed account data when absent from `getVoteAccounts`. A retired identity without an active mapping requires its existing vote account for performance/revenue. BAM additionally accepts an explicit historical claimant identity.

## Legacy configuration migration

Version 1 files remain readable, including their custom `rpcEnv` references. Run `bun src/skills/onboarding/scripts/onboard.ts migrate [--config PATH]` while those variables are available. It verifies every saved vote/identity pair before atomically writing version 2 with URLs and no `rpcEnv`; a missing URL, wrong network or identity drift leaves the file unchanged. `--rpc URL` explicitly supplies one endpoint for all profiles during migration. Identity drift requires an intentional `refresh` first.

Adding or refreshing one profile saves its URL without requiring credentials for unrelated profiles. A file with remaining legacy references stays version 1 (and may contain upgraded URL profiles) until all references are removed; then it is written as version 2. Ordinary queries never migrate configuration. Identity-only `refresh` preserves an existing URL; use onboarding `refresh --profile NAME --rpc URL` to replace it explicitly.
