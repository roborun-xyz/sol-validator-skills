---
created: 2026-09-15
last_updated: 2026-09-30
---

# Preparing an instance-specific upgrade

Read [host inventory](../inventory/references/hosts.md) and the operator's selected inventory at `VALIDATOR_OPS_HOST_INVENTORY` or `~/.config/validator-ops/hosts.md`, respecting an explicit operator path. This inventory includes backup instances; SFDP `fleet.json` cannot replace it. Missing or stale fields block only dependent actions; verify live roles before mutations. Never select the bundled private inventory automatically. These skills support Agave/Jito-Agave and Firedancer/Frankendancer instances only when the installed CLI, supervisor, identity-switching and tower behavior have been verified. A full Firedancer release may differ from a Frankendancer deployment: do not assume Agave admin commands work for both.

Complete read-only discovery and prepare a concrete runbook before asking for any missing execution authorization. Record the target release/tag or custom remote/ref and resolved commit, source provenance, build/install/start paths, matching admin CLI, exact supervisor, affected instance and rollback. Check upstream release notes and the target CLI help; never derive an Agave revision solely from a Firedancer version number. Verify network/SFDP compatibility where relevant. Retain explicit user authorization within its scope; do not ask again for every routine step already authorized.

Use the exact verified release tag/ref rather than constructing a tag from a version string or assuming a fork's tag scheme. For a mainnet identity handoff, apply [readiness and tower verification](mainnet-failover.md); for a borrowed backup, also apply [role switching and restoration](backup-role-switch.md).

Commands must be instantiated for the verified host. Pass SSH destinations as arguments with `BatchMode=yes`, a connection timeout and `--`; reject aliases beginning with `-`, whitespace, or shell syntax. Quote remote arguments with a shell-quoting function, or transfer a reviewed script with explicit parameters. Never paste an untrusted branch, path or label into a remote shell string. Prefer absolute paths; do not rely on login PATH or an assumed sudo environment.

## Build and configuration

- Preserve the running binary and configs for rollback; identify whether the startup wrapper uses a source-tree build output directly. Build in an isolated checkout/output where necessary so a supervisor restart cannot start an unverified binary.
- Record dirty changes and never discard them. Fetch the intended upstream/tag, resolve its commit and submodules, and use the release's supported toolchain. Choose a build job limit from available CPU/memory and co-located workloads.
- Check the built executable's version and checksum. A successful build does not establish that the startup command will use it.
- Record the installed executable's ownership, mode and any required Linux file capabilities or other deployment-required attributes. Verify requirements against the target release, launcher and enabled features; do not assume a universal root owner or capability set. Stage and inspect the candidate before stopping. Recheck the final installed path after copy/ownership changes, and preserve the same requirements in rollback.
- Inspect plugins and optional integrations in every launcher/config that an upgrade, role switch or rollback may start. Verify client/plugin ABI and configuration compatibility against their exact releases. A clean primary launcher does not establish that an alternate launcher is compatible. Check dependent consumers before an authorized disablement; a historical zero-connection observation does not establish that a plugin is unused now. Do not remove plugin flags as a default upgrade fix.
- For Firedancer, use the target CLI's `configure check all --config <CONFIG>` during live preflight. Review removed/renamed config keys against release guidance; do not blindly delete unknown keys. Stage both staked and unstaked config changes where relevant.
- `configure init` can affect hugepages and networking. Run it only in a verified stopped-instance phase and after accounting for co-located services. A conflict is not authorization to stop another validator.

## Stop, install and restart

Disable the exact supervisor/retry loop first. Observe what it actually stopped; systemd and screen wrappers differ. Prefer the installed client's supported clean shutdown against the correct ledger/admin socket. If unavailable, identify the instance's exact PIDs from executable, owner, config and ledger before sending SIGTERM. SIGKILL requires a diagnosed failure of graceful shutdown and explicit scope; never use global `pkill fdctl` or `killall agave-validator` on a shared host.

Confirm the intended process is gone and other instances remain healthy. Install the verified binary with recorded owner/mode and required capabilities/attributes, verify them on the destination, and restart using the recorded working directory, config and supervisor. Verify supervisor persistence, actual process executable, local identity, voter loading where applicable, version and health. Poll bounded operations and inspect logs for progress; a fixed elapsed time is not proof of readiness.

For a voting testnet restart, check leader schedule before building and immediately before stopping. Use a conservative operator-approved maintenance window (45 minutes is the starting policy), adjusted for observed build/restart time. No remaining slots in the current epoch does not prove a safe window across the next epoch; obtain adequate schedule coverage or wait. Slot-to-time conversion is an estimate, not a timing guarantee.

## Rollback and outcomes

Prepare rollback before stopping: old binary/config, plugin compatibility, required executable capabilities/attributes, supervisor commands and identity state. Never change voting identity as a blind rollback. If a backup is voting, keep it there while repairing the primary. If submission or identity switching is ambiguous, inspect local identities and chain vote progress before retrying. Do not restore a stale tower or promote two instances simultaneously.

Report UTC and local time, old/new versions and commits, actual running binary, identities/roles, health/catchup, vote progress, supervisor state, co-located instance health, and remaining uncertainty. Write concise durable outcomes to an operator-selected local record outside the release tree. Never claim successful upgrade based solely on build output, a process listing or one health response.

## Primary references

[Firedancer CLI](https://docs.firedancer.io/api/cli.html) documents the startup-config requirement for `set-identity`, saved-tower enforcement, and partially changed identity state after cancellation. Do not interrupt an in-progress identity change as a routine timeout response or automatically add `--force`; diagnose local/chain state and prepare recovery first.

[Firedancer initialization](https://docs.firedancer.io/guide/initializing.html) distinguishes nonmutating `check` from host-changing `init`. These references support the runbook's invariants; the installed target release remains authoritative for available commands and compatible tower formats.
