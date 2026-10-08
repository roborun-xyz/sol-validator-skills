---
name: upgrade-agave
description: Upgrade an operator-configured Agave or Jito-Agave unstaked mainnet backup, verifying its current role, isolated process lifecycle, installed binary and catchup.
license: MIT
compatibility: Requires SSH and release-matched validator/build tooling. Mainnet checks use the configured mainnet RPC; optional onboarding uses Bun 1.3.3.
metadata:
  created: "2026-05-27"
  last_updated: "2026-10-08"
---

# Upgrade an Agave backup

Read [installed bundle and configuration](shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply `shared-upgrade-runbook.md` and onboard missing instance details with `inventory.md`. Resolve the requested backup from operator-owned inventory; there are no default hosts, users or filesystem paths.

For a voting Agave/Jito-Agave primary upgrade through a backup, use [upgrade-agave-primary](../SKILL.md).

1. Verify through local identity and chain state that this instance is currently unstaked and is not carrying votes after a failover. Confirm its network, supervisor, ledger, installed binary, source upstream and shared workloads. If it is currently voting, prepare an appropriate failover first; this runbook alone does not authorize stopping it.
2. Verify the requested Agave/Jito-Agave release and upstream. Preserve the current executable/config and build the exact target revision with a conservative job count. The usual Cargo target is `agave-validator`; confirm target-release build instructions and locked dependencies. Verify build version/checksum.
3. Prepare exact stop/install/start and rollback commands for the selected instance. The build output and executable used by its supervisor may differ. Verify the destination before stopping.
4. Stop the selected supervisor/retry loop, then gracefully stop the remaining instance through its supported admin command or scoped SIGTERM. Inspect the admin socket instead of assuming it exists or is absent. Never kill every Agave process on a shared host.
5. Install the verified binary with correct ownership, mode and deployment-required capabilities/attributes, rechecking the final destination. Verify plugin compatibility for any role/rollback launcher involved. Start with the recorded unstaked identity and original supervisor; verify the process actually uses the new executable.
6. Wait for measured catchup and healthy local RPC. Verify network, version, unstaked identity, expected vote-account configuration, and unrelated instances. Re-check current required versions and report whether the backup is ready for its declared failover role.

Do not promote the backup, change keys or voting authorization, delete ledgers, download snapshots, or stop co-located testnet services as an incidental upgrade step. Diagnose those separately when needed. If an authorized operation also changes the backup's assigned role, apply [role switching](shared-backup-role-switch.md) and report restoration of the original coverage. An unstaked node can still be important failover infrastructure; do not describe its restart as risk-free.
