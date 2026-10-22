---
name: upgrade-mainnet
description: Upgrade an operator-configured Firedancer primary through a verified Agave backup, preserving single-validator voting and fresh vote-history requirements across failover and failback.
license: MIT
compatibility: Requires SSH and release-matched validator/build tooling. Mainnet checks use the configured mainnet RPC; optional onboarding uses Bun 1.3.3.
metadata:
  created: "2026-05-27"
  last_updated: "2026-10-22"
---

# Upgrade mainnet Firedancer with an Agave backup

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply `../shared/upgrade-runbook.md` and onboard both instances using `../inventory/instructions.md`. This procedure requires a verified compatible Firedancer/Frankendancer primary and Agave backup for the same vote account. There are no default host pairs or identities. Do not apply it to an Agave primary or a deployment whose identity/vote-history compatibility is unverified. Mainnet runs Alpenglow; follow the client table in [mainnet handoff](../shared/mainnet-failover.md).

For a voting Agave/Jito-Agave primary, use [upgrade-agave-primary](../upgrade-agave-primary/instructions.md).

## Prepare

Verify both instances' actual identities, version, health, catchup, supervisor, key paths, vote-history locations, and restart identity persistence. The Agave backup and any rollback launcher must be Alpenglow-capable (4.3.2 or later). The backup must be unstaked, healthy, caught up, release-compatible and compliant with applicable current version requirements. Upgrade it first with `upgrade-agave` if needed. Confirm it is not carrying another validator's votes, and serialize all operations sharing that backup.

Apply [mainnet handoff readiness](../shared/mainnet-failover.md) in both directions, including loaded voter, BLS registration and vote-account VAT checks before demotion, quarantine of stale staked vote history on the receiver, and the finalized-slot gate against the final transferred vote history before promotion. If the backup is borrowed from another validator, use [role switching and restoration](../shared/backup-role-switch.md).

Resolve the requested target release/ref and commit. **Hard gate:** the target Firedancer build (and the running primary and any rollback build) must be at or above the SFDP `firedancer_full_min_version` published for every epoch the primary may vote in during the operation, and its release notes or source must confirm Alpenglow participation. A fork such as FireBAM must map to a verified upstream release that meets this floor. If either fact is unverified, stop before failover. Prepare the build, config migration, scoped stop/start, failover, failback and rollback commands using exact verified paths and target CLI help. Record public keys for staked and distinct unstaked identities; never copy keypair contents. Complete this preparation before requesting any missing production authorization.

Complete an isolated build and stage installation/config changes before borrowing the backup when resources permit and the current supervisor cannot start the candidate accidentally. Otherwise include build time in the failover/coverage plan.

## Fail over

1. Inspect the installed primary binary's `set-identity --help`. Demote the primary to its verified unstaked identity with that command and the documented instance selector (`--name`/`--config`). Verify the resulting local identity. Ensure its supervisor would restart it unstaked before continuing; runtime identity and restart configuration are separate facts.
2. After demotion, copy the staked identity's vote history saved by the switch away (for full Firedancer v26.10.x, `[paths.vote_history]/vote_history-<staked>.bin.bak`; if it stopped without switching away, `vote_history-<staked>.bin`) to the backup ledger as `vote_history-<staked>.bin`, using an explicit unique temporary file. Verify source/destination SHA-256, identity, runtime ownership and required permissions. Never reuse older or quarantined vote history, and never transfer a tower file. If freshness, the file name for the installed release, or demotion is uncertain, stop before promotion.
3. Recheck backup readiness and the finalized-slot gate using the shared handoff procedure, then promote with the verified Agave binary and ledger, the staked identity path, and plain `set-identity` (vote history required by default; never `--do-not-require-vote-history`). Verify local identity/health and on-chain vote-account progress/non-delinquency through the configured RPC. Confirm the primary remains unstaked. Do not proceed on an ambiguous identity-switch result.

## Upgrade the primary

Finish any remaining build preparation while the backup votes, preserving rollback artifacts. Validate the new config with read-only `configure check`; stage both staked and unstaked configurations. Follow the shared runbook to stop the primary's exact supervisor and process, initialize only after it is stopped, install the binary and restart **unstaked**. A full Firedancer instance that switched away from the identity it booted as may refuse to boot until that identity's vote history is back in `[paths.vote_history]`; restore only the latest file from the validator that last ran that identity, never a quarantined or older copy, and stop for diagnosis if that is ambiguous.

Verify actual running version, primary unstaked identity, supervisor persistence and full catchup. Continue monitoring backup voting throughout. Do not fail back until the primary is ready. If upgrade fails, keep the backup voting and repair or roll back the primary while it remains unstaked.

## Fail back

1. Recheck primary catchup and loaded voter readiness before demoting the backup. Demote the backup to its verified unstaked identity using its exact Agave ledger. Verify local identity and restart persistence.
2. Before the copy, move aside any staked-identity vote history (`.bin`, `.bin.bak`, `.bin.swp`) in the primary's `[paths.vote_history]`. Copy the backup's fresh `vote_history-<staked>.bin` from its ledger to a unique path on the primary **outside** `[paths.vote_history]`. Repeat checksum, ownership, identity and freshness checks; never restore pre-upgrade vote history or a tower.
3. Recheck the primary's catchup and the finalized-slot gate using the shared handoff procedure. Promote only if the installed primary binary's help matches a verified procedure: for full Firedancer v26.10.x, `set-identity <staked> --vote-history-file <copied path>`; never omit `--vote-history-file` (that treats the identity as never having voted) and never use `--require-tower`. If the installed binary (for example a FireBAM fork or `fdctl`) shows different flags or file semantics, leave the backup voting and stop for an operator-confirmed procedure. Verify its local identity, health and on-chain vote progress while the backup stays unstaked.
4. Restore the primary's intended persistent restart policy only after validating the live transition, including any deliberate warmup-first policy and voter loading. Verify the backup's persistent config stays unstaked. Do not assume a symlink switch changes a running process's identity.

## Verify and record

Verify single-instance voting, vote-account identity, advancing finalized votes/non-delinquency, installed version, both supervisor states and unrelated workloads. Observe upcoming leader opportunities when available; record when no leader sample was observed. Do not delegate routine chain verification back to the user as a required manual explorer check.

If the backup was borrowed, restore and verify its original unstaked role and catchup before reporting backup coverage restored.

Report UTC/local times and durable before/after state in the operator's local record. An ambiguous promotion or failed failback requires identity and vote-history diagnosis, not a blind retry. Never promote either side without the fresh vote history from the just-demoted voter, and never run concurrent failovers through the same backup.
