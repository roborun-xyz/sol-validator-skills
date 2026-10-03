---
name: onboarding
description: Create, repair, or refresh local Solana validator profiles, persisted Helius RPC URLs, and SFDP identity-pair configuration. Use for first setup, adding validators, or missing query configuration; host discovery and layout belong to inventory.
license: MIT
compatibility: Requires Bun 1.3.3. Chain verification requires Helius mainnet RPC; local status needs no RPC. Optional SFDP validation uses Python 3 in a project virtual environment.
metadata:
  created: "2026-09-16"
  last_updated: "2026-09-30"
---

# Validator Onboarding

Read [installed bundle and configuration](shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Own task configuration at any stage, including adding validators and repairing existing profiles. Reuse existing configuration and collect only what the requested task needs.

## Chain profiles and RPC configuration

Performance and revenue scripts use the shared resolver at `src/skills/shared/operator-config.ts` in the runtime. They require a mainnet validator and Helius RPC; they do not require SSH or signer access. Read [profile configuration](onboarding-references-profiles.md) for commands and the configuration format.

1. Run `bun src/skills/onboarding/scripts/onboard.ts status` (pass the user's `--config` if supplied). Inspect the resolved paths and per-file status for profiles, fleet and hosts; absent unrelated files do not block the requested workflow. For a local-status-only request, report these diagnostics and stop; do not start configuration or chain verification. Otherwise reuse existing profiles. If several exist without a default, ask which validator the current task concerns.
2. Ask only for missing information: vote account or identity, a short profile name, and the user's Helius RPC URL. Reuse an existing saved URL when available. Prefer having the user set `SOLANA_RPC_URL` locally; onboarding saves its value after verification. If the user already supplied a URL, use it without asking again. Never echo credentials.
3. Run `onboard.ts add --profile NAME --validator PUBKEY [--rpc URL]`. It validates the mainnet genesis and resolves the current vote/identity pair through read-only RPC before saving the URL, vote account and identity in private operator configuration. Add `--default` only when the user has chosen that default; one profile is automatically selectable without a default.
4. Report the verified profile, then resume the original task with `--profile NAME`. Onboarding is not a reason to stop before completing the user's requested check.
5. If `PROFILE_CONFLICT` reports identity drift, explain the changed relationship, investigate it, then use `refresh` when the operator intends that update. Do not silently rewrite it during an ordinary check. Ordinary query CLI/environment overrides never persist. An identity-only refresh preserves the saved URL; an explicit onboarding `--rpc` updates it. Use `migrate` to explicitly convert legacy RPC environment references to saved URLs; missing variables block migration without changing the file.

Missing credentials block only dependent RPC work. Missing SSH or signers does not block performance/revenue onboarding. Profiles store no execution approvals and do not replace live preflight for mutations.

## SFDP and host-check onboarding

Read [local fleet onboarding](onboarding-references-fleet.md) for SFDP identity pairs and optional host checks. Validate the file before network calls and resume the requested check. No SSH is needed for participation-only checks.

## Host-dependent configuration

When the task needs host discovery, roles, paths, signer roles, or failover relationships, use [inventory](inventory.md) to establish those facts. For SFDP live checks, map only verified facts into the fleet schema; fleet entries do not replace host inventory. Missing host information blocks only dependent work. Resume the original task after configuration is complete.
