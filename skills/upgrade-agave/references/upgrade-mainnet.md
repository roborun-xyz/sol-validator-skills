---
name: upgrade-mainnet
description: Upgrade an operator-configured Firedancer primary through a verified Agave backup, preserving single-validator voting and fresh-tower requirements across failover and failback.
license: MIT
compatibility: Requires SSH and release-matched validator/build tooling. Mainnet checks use the configured mainnet RPC; optional onboarding uses Bun 1.3.3.
metadata:
  created: "2026-05-27"
  last_updated: "2026-10-08"
---

# Upgrade mainnet Firedancer with an Agave backup

Read [installed bundle and configuration](shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply `shared-upgrade-runbook.md` and onboard both instances using `inventory.md`. This procedure requires a verified compatible Firedancer/Frankendancer primary and Agave backup for the same vote account. There are no default host pairs or identities. Do not apply it to an Agave primary or a deployment whose identity/tower compatibility is unverified.

For a voting Agave/Jito-Agave primary, use [upgrade-agave-primary](upgrade-agave-primary.md).

## Prepare

Verify both instances' actual identities, version, health, catchup, supervisor, key paths, ledger/tower format, and restart identity persistence. The backup must be unstaked, healthy, caught up, release-compatible and compliant with applicable current version requirements. Upgrade it first with `upgrade-agave` if needed. Confirm it is not carrying another validator's votes, and serialize all operations sharing that backup.

Apply [mainnet handoff readiness](shared-mainnet-failover.md) in both directions, including loaded voter verification before demotion and the receiver's local replay check against the final transferred tower before promotion. If the backup is borrowed from another validator, use [role switching and restoration](shared-backup-role-switch.md).

Resolve the requested target release/ref and commit. Prepare the build, config migration, scoped stop/start, failover, failback and rollback commands using exact verified paths and target CLI help. Record public keys for staked and distinct unstaked identities; never copy keypair contents. Complete this preparation before requesting any missing production authorization.

Complete an isolated build and stage installation/config changes before borrowing the backup when resources permit and the current supervisor cannot start the candidate accidentally. Otherwise include build time in the failover/coverage plan.

## Fail over

1. Demote the primary to its verified unstaked identity using the installed fdctl's `set-identity` command and exact config. Verify the resulting local identity. Ensure its supervisor would restart it unstaked before continuing; runtime identity and restart configuration are separate facts.
2. After demotion, copy the freshly written tower for the staked identity from the primary ledger to the backup ledger using an explicit unique temporary file. Verify source/destination SHA-256, tower identity/format, runtime ownership and required permissions. Never reuse an older backup tower. If tower freshness or demotion is uncertain, stop before promotion.
3. Recheck backup readiness against the final tower using the shared handoff procedure, then promote with the verified Agave binary and ledger, the staked identity path, and `set-identity --require-tower`. Verify local identity/health and on-chain vote-account progress/non-delinquency through the configured RPC. Confirm the primary remains unstaked. Do not proceed on an ambiguous identity-switch result.

## Upgrade the primary

Finish any remaining build preparation while the backup votes, preserving rollback artifacts. Validate the new config with read-only `configure check`; stage both staked and unstaked configurations. Follow the shared runbook to stop the primary's exact supervisor and process, initialize only after it is stopped, install the binary and restart **unstaked**.

Verify actual running version, primary unstaked identity, supervisor persistence and full catchup. Continue monitoring backup voting throughout. Do not fail back until the primary is ready. If upgrade fails, keep the backup voting and repair or roll back the primary while it remains unstaked.

## Fail back

1. Recheck primary catchup and loaded voter readiness before demoting the backup. Demote the backup to its verified unstaked identity using its exact Agave ledger. Verify local identity and restart persistence.
2. Copy the fresh staked-identity tower from the just-demoted backup back to the primary. Repeat checksum, ownership, format and freshness checks; never restore the pre-upgrade tower.
3. Recheck the primary against the final tower using the shared handoff procedure, then promote with the verified fdctl/config and `set-identity --require-tower`. Verify its local identity, health and on-chain vote progress while the backup stays unstaked.
4. Restore the primary's intended persistent restart policy only after validating the live transition, including any deliberate warmup-first policy and voter loading. Verify the backup's persistent config stays unstaked. Do not assume a symlink switch changes a running process's identity.

## Verify and record

Verify single-instance voting, vote-account identity, advancing finalized votes/non-delinquency, installed version, both supervisor states and unrelated workloads. Observe upcoming leader opportunities when available; record when no leader sample was observed. Do not delegate routine chain verification back to the user as a required manual explorer check.

If the backup was borrowed, restore and verify its original unstaked role and catchup before reporting backup coverage restored.

Report UTC/local times and durable before/after state in the operator's local record. An ambiguous promotion or failed failback requires identity and tower diagnosis, not a blind retry. Never promote either side without the fresh tower from the just-demoted voter, and never run concurrent failovers through the same backup.
