---
name: inventory
description: Discover, verify, and maintain Solana validator host and instance facts, including roles, paths, signer roles, and failover relationships. Use when adding servers or refreshing host layout; chain profiles, RPC configuration, and SFDP identity-pair setup belong to onboarding.
license: MIT
compatibility: Requires shell and SSH for host discovery; Bun 1.3.3 for optional onboarding.
metadata:
  created: "2026-05-27"
  last_updated: "2026-09-25"
---

# Validator Inventory

Read [installed bundle and configuration](shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Own host and signer facts for both new and existing instances. Read [host and signer inventory](inventory-references-hosts.md) for discovery and verification. Use the operator-selected `VALIDATOR_OPS_HOST_INVENTORY` or `~/.config/validator-ops/hosts.md`. Never default to a private fleet bundled in an existing checkout. Reuse an explicitly selected inventory after checking relevance and freshness.

For missing or outdated chain profiles, RPC references, or SFDP identity-pair configuration, use [onboarding](onboarding.md). Host observations, chain profiles and local signer roles are separate evidence; none establishes the others or grants execution authorization.

## Workflow

1. Read the shared inventory only when the task depends on host layout.
2. Verify relevant facts through user confirmation or read-only SSH/RPC checks before changing them.
3. Ask only for facts that cannot be discovered safely.
4. Update current facts and the check timestamp; remove superseded detail instead of accumulating history.
5. Treat unknown or stale facts as blockers for destructive operations.

## Keep

- Active aliases and roles.
- Cluster, client/version, identity, vote account, RPC, config, ledger, accounts, key paths, and service/screen.
- Failover relationships and safety constraints.
- A short note for unreachable or retired aliases when it prevents misuse.

## Omit

- Private keys, seeds, passwords, API keys, SSH keys, and tokens.
- Full command logs, migration narratives, old hardware snapshots, and per-refresh changelogs.
- Superseded values already recoverable from Git history.

When updating Markdown, preserve `created` and set `last_updated` in frontmatter. Report UTC and local check time.
