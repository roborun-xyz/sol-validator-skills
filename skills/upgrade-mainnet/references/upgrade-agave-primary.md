---
name: upgrade-agave-primary
description: Upgrade a voting Agave or Jito-Agave mainnet primary through a verified compatible Agave backup, including failover, failback and rollback. Use upgrade-agave for an unstaked backup alone.
license: MIT
compatibility: Requires SSH and release-matched validator/build tooling. Mainnet checks use the configured mainnet RPC; optional onboarding uses Bun 1.3.3.
metadata:
  created: "2026-09-20"
  last_updated: "2026-10-08"
---

# Upgrade an Agave primary through a backup

Read [installed bundle and configuration](shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply [upgrade preparation](shared-upgrade-runbook.md) and [mainnet identity handoff](shared-mainnet-failover.md). This workflow requires an Agave/Jito-Agave primary and a verified compatible Agave/Jito-Agave backup for the same vote account. For a Firedancer primary, use [upgrade-mainnet](../SKILL.md); for an unstaked backup upgrade, use [upgrade-agave](upgrade-agave.md).

## Prepare before failover

Verify missing or stale facts through [inventory](inventory.md). There are no default hosts, identities, key paths or supervisors.

1. Verify live roles, local and restart identities, vote account, voter availability, installed binaries, supervisors, ledger/tower compatibility and co-located workloads. Confirm the backup is unstaked and not serving another validator's votes. Upgrade it first with `upgrade-agave` if its release is unsuitable.
2. Resolve the requested upstream, target release/ref and commit. Prepare an isolated build and stage the verified binary/configuration before failover when this cannot affect the running executable or its restart path. Preserve rollback artifacts and apply the shared installation, capabilities and integration checks.
3. Prepare exact instance-specific stop/start, identity-switch, tower-transfer, failback and rollback commands using the installed and target CLI help. Include the incoming node's loaded authorized voter in preflight; a production identity key is not evidence of voter availability.
4. If the backup must change duties, use [backup role switching](shared-backup-role-switch.md) to prepare the target role, coverage window and restoration. Serialize all operations sharing that backup. Complete preparation before requesting any missing execution authorization; configuration alone grants none.

## Fail over and upgrade

1. Follow the shared identity handoff with the primary as outgoing and backup as incoming: verify incoming readiness and voter availability, demote the primary, confirm its live and persistent restart identities are unstaked, transfer the freshly written tower with the required verification, and promote the backup using `set-identity --require-tower`. Confirm single-instance voting and on-chain vote-account progress before stopping the primary.
2. Stop only the primary's verified supervisor and process. Install the staged release through the shared procedure and restart the primary unstaked. Verify the actual executable/version, supervisor persistence and integration health while monitoring backup votes.
3. Wait for measured catchup and complete the shared incoming readiness and authorized-voter checks on the restarted primary. Do not demote the backup until the primary is ready for handoff. An ambiguous identity transition requires diagnosis, not a repeated promotion command.

## Fail back and restore coverage

1. Repeat the shared handoff with the backup as outgoing and primary as incoming. Demote the backup and verify its unstaked restart state; copy its fresh tower back with the required verification. Promote the primary using `set-identity --require-tower` only after the incoming readiness gate passes against this handoff's evidence.
2. Verify local identity, advancing chain votes, non-delinquency and that the backup remains unstaked. Set and verify the primary's intended persistent restart configuration after the live transition succeeds, including voter availability on that restart path.
3. Restore any borrowed backup to its previous agreed role using the role-switch procedure. Verify restored identity, configuration, health and measured catchup before declaring its coverage restored.
4. Record UTC/local times, versions/commits, actual running binaries, roles, vote progress, integration checks, supervisor states and remaining uncertainty in the operator's local record. Observe a leader opportunity when available; report when no leader sample was observed.

## Rollback

If the upgraded primary fails while the backup is voting, keep the backup voting. Restore the primary's verified binary/configuration and required installation attributes, restart unstaked, and repeat the same readiness and failback gates. Never use the pre-upgrade tower for failback. If the primary has already resumed voting, establish the current identities and prepare a fresh handoff before another restart; do not treat rollback as permission for an unplanned identity switch.
