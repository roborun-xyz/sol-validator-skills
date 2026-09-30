---
created: 2026-09-15
last_updated: 2026-09-20
---

# Host and signer inventory

Use the operator-selected `VALIDATOR_OPS_HOST_INVENTORY` path or `~/.config/validator-ops/hosts.md`. This Markdown file is operator-owned and is never a bundled fleet default. Ask for missing information only; discover process layout through authorized read-only SSH when a target alias is already supplied. An explicit existing inventory path can be reused after checking its relevance and freshness.

Before a host-based upgrade, record the following for **each validator instance**, including other instances sharing that host:

| Field | Required evidence |
|---|---|
| SSH alias and runtime user | Successful batch-mode SSH; verified process owner |
| Cluster, role, identity, vote account | Local process/RPC identity and selected network; chain identity relationship where applicable |
| Client family and running version | Actual running executable and version; do not infer from directory names |
| Source checkout and upstream | Absolute directory, remote URL, current commit, dirty status |
| Build output and installed binary | Absolute paths; compiler/toolchain and release-specific build instructions |
| Executable requirements | Required owner/mode and capabilities/attributes for enabled features; verified on the actual installed path |
| Configuration and working directory | Absolute config path, resolved symlink target, startup command, relevant environment variable names |
| Plugins and alternate launchers | Client/plugin release compatibility, dependent consumers, and each role/rollback configuration that may start |
| Data layout | Ledger/accounts paths, ownership, free space, local RPC port, admin socket availability |
| Supervisor | Exact systemd unit or screen/tmux session, wrapper path, retry/restart behavior and scoped stop/start commands |
| Staked/unstaked state | Public keys and remote key **paths**, on-chain voter authorization versus process-loaded voters, restart identity and voter persistence |
| Backup pairing | Which vote account it may take over, distinct unstaked identity, tower path/format, isolation from other failovers; original/target roles and coverage impact if borrowed |
| Shared resources | Other validator instances and services, memory/hugepage/NIC conflicts, safe build job limit |
| Rollback | Last working binaries, configs/plugins, revision, owner, required capabilities/attributes and commands; no private keys in copies |
| Verification | UTC and local check time, source of each fact, unknown fields explicitly marked |

Do not guess paths, assign a backup based on its hostname, or reuse an example's identity. A live unstaked backup may temporarily be voting after a failover: verify current role every time. Historical inventory is discovery context, not proof of readiness.

Maintain `created` and `last_updated` frontmatter. Create local directories as `0700` and inventory files as `0600`. Store public keys and necessary paths only; exclude secrets, RPC URLs with credentials, SSH private keys, seeds, and keypair contents. Keep the inventory outside the release tree.

## Discovery and refresh

1. Resolve the requested host/instance and action. Ask for an SSH alias only if it is not already available.
2. Read any operator inventory; discover missing process/config details read-only. Inspect configuration selectively and redact credential values. Do not dump environment files or command arguments containing tokens.
3. Present unresolved facts that affect the action together: runtime/layout, supervisor, backup relationship, and restart identity. Mark unverified fields explicitly. Save verified observations and resume preparation of the original task.
4. For financial operations, ask for **local** signer paths by role (identity, withdrawer, fee payer). Verify with `solana-keygen pubkey`; never read JSON key contents or infer local signers from remote paths. Signer availability must not block read-only chain queries.
5. Before mutation, prepare a concrete instance-specific runbook using the applicable upgrade or bond skill. Prior authorization remains valid within its stated scope; inventory never stores a blanket execution approval.

Missing layout blocks only dependent host operations. Do not require SSH, backup or signer onboarding for performance, revenue, or participation-only checks.
