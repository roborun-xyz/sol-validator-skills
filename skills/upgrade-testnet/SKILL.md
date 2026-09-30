---
name: upgrade-testnet
description: Upgrade Firedancer or Frankendancer on an operator-configured testnet instance with leader-window checks, release-matched tooling, scoped restart and voting verification.
license: MIT
compatibility: Requires SSH and release-matched validator/build tooling. Mainnet checks use Helius RPC; optional onboarding uses Bun 1.3.3.
metadata:
  created: "2026-05-27"
  last_updated: "2026-09-30"
---

# Upgrade testnet Firedancer

Read [installed bundle and configuration](references/shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply `references/shared-upgrade-runbook.md`. Resolve the testnet instance using operator-owned inventory; use `references/inventory.md` for missing host, config, binary, supervisor or identity information. Do not reuse another operator's paths, compiler choice or backup relationships.

1. Verify testnet identity, vote account, local RPC health, installed client, ledger and co-located services. Record actual startup identity and authorized-voter behavior: some instances start directly staked, others require a deliberate identity transition.
2. Check the upcoming leader schedule with coverage sufficient for the maintenance window, before building and again immediately before stopping. Use the shared runbook's conservative window policy. Near an epoch boundary, missing next-epoch coverage is not permission to restart.
3. Preserve old executable/config and build the requested Firedancer revision and recursive submodules using its supported compiler/build targets. Use a bounded job count that does not starve the live validator. Confirm both built and intended installed executables.
4. If this deployment uses Agave admin shutdown, obtain the matching Agave revision from the release notes/submodule and validate its CLI before the stop phase. Do not infer compatibility from a version suffix or reuse an arbitrary system binary.
5. Run the new fdctl's read-only config check. Review necessary config changes and maintain rollback copies. Inspect init-stage failures for effects on shared hugepages/NICs; do not stop a mainnet backup to free memory without a separate approved plan.
6. Recheck the maintenance window, stop only the testnet supervisor/retry loop and instance, and verify it is stopped. Perform required initialization only in this stopped phase. Install/start with the recorded config and identity policy.
7. Verify supervisor persistence, running executable/version, testnet identity, catchup, vote progress and delinquency, plus health of co-located instances. If an identity promotion is needed, use the deployment's verified tower/identity procedure; do not improvise it from a different host's layout.

For failure or rollback, follow the shared runbook. Never automatically delete a ledger, replace a snapshot, restore a stale tower, or interrupt another instance. Report measured readiness and any missed leader window rather than declaring success after a fixed wait.
