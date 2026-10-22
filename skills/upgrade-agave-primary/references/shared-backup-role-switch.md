---
created: 2026-09-20
last_updated: 2026-10-22
---

# Switching a shared backup's role

Use only when an authorized operation needs an unstaked backup to change which validator it can take over. A backup assignment in inventory does not prove its live role. This procedure changes the backup configuration; promotion is a separate [mainnet handoff](shared-mainnet-failover.md).

## Before changing roles

Record the original and target network, vote account, production/unstaked identity public keys, authorized voter, launcher, supervisor, data paths and vote-history location from live evidence and the operator's inventory. Enumerate matching instances; do not select the first process by name. Confirm the selected backup is unstaked and is not currently carrying another validator's votes. A voting instance requires its own verified handoff before it can be repurposed.

Identify which validator loses backup coverage, any overlapping maintenance and shared ledger/accounts/ports/NICs or co-located services. Serialize operations using this backup. Include the coverage window and restoration plan in the concrete operation scope; retain existing authorization when it covers that impact, and obtain only missing authorization before the switch. Complete isolated builds and staging beforehand when this can safely shorten the borrowed-backup window.

Inspect every launcher/config that the operation or rollback may start. Check target identities, voter availability, release compatibility and plugin dependencies using [upgrade preparation](shared-upgrade-runbook.md). Do not derive a second role by substituting three flags without reviewing the rest of the configuration. Every launcher, including the original role's restore launcher, must run an Alpenglow-capable release (Agave/Jito-Agave 4.3.2 or later); refuse to stage an older one. Preserve each role's restart policy and compatible configs. A `vote_history-<staked>.bin` already in the shared ledger is stale for the new role: move it aside as described in [mainnet handoff](shared-mainnet-failover.md) and never let it authorize promotion.

## Switch and verify

1. Disable only the selected supervisor/retry loop, stop the exact verified instance and confirm it is gone while unrelated workloads remain healthy.
2. Activate the verified target-role configuration and start it **unstaked** with its recorded supervisor. Only one instance may own shared data directories and ports. Confirm the supervisor persists and inspect the actual executable, live identity, vote account and loaded voter.
3. Measure health and catchup, check logs for plugin/restart failures, and verify persistent startup identity. Keep the production primary voting until the target backup satisfies the pre-demotion readiness checks in [mainnet handoff](shared-mainnet-failover.md). Role-switch success alone is not permission to promote.
4. If preparation fails before promotion, restore the original compatible launcher/config and verify its unstaked role and catchup. Do not leave a validator without its planned backup without reporting the changed coverage.

## Restore coverage

After the primary has resumed verified voting, confirm the borrowed backup is demoted and will restart unstaked. Stop its exact instance, restore the original role, and verify its version/config/plugin compatibility, supervisor, local identity, vote account, voter readiness, health and measured catchup. If binaries changed during the operation, do not assume the original launcher is still compatible, and refuse to restore a pre-4.3.2 (non-Alpenglow) binary. Move aside any vote history for the borrowed role's staked identity left in the ledger so it cannot be mistaken for fresh state later.

Check co-located workloads and confirm the original validator's backup coverage is restored. Report any unfinished restoration explicitly. Update `VALIDATOR_OPS_HOST_INVENTORY` or `~/.config/validator-ops/hosts.md` with verified current roles and UTC/local timestamps; keep the outcome in the operator's private log, never in a public skill or bundled fleet file.
