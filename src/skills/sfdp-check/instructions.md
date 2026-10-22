---
name: sfdp-check
description: Check Solana Foundation Delegation Program participation and required software versions for an operator's mainnet/testnet identity pair, optionally verifying host health, identity, and client version over SSH.
license: MIT
compatibility: Requires Python 3 in a project virtual environment and internet access; SSH only for optional live host checks.
metadata:
  created: "2026-05-27"
  last_updated: "2026-10-22"
---

# SFDP Check

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Read `../onboarding/references/fleet.md` for SFDP configuration. Reuse the operator's local fleet file; never default to another operator's validators. If identity-pair configuration is missing, use `../onboarding/instructions.md`. If live checks need host facts, use `../inventory/instructions.md` to verify them, then map them into the fleet configuration through onboarding and resume the check.

Create the project virtual environment once with `python3 -m venv .venv`. The checker uses only the Python standard library.

```bash
.venv/bin/python src/skills/sfdp-check/scripts/check_sfdp.py --fleet /path/to/fleet.json --api-only
.venv/bin/python src/skills/sfdp-check/scripts/check_sfdp.py --fleet /path/to/fleet.json --json
```

The default fleet path is `~/.config/validator-ops/fleet.json`; `VALIDATOR_OPS_FLEET` overrides it. `--validate-config` validates the file without network or SSH access.

The checker fetches required versions from the Foundation's `sfdp_required_versions?cluster=<cluster>` API and participation from `sfdp_participants`, under `https://api.solana.org/api/community/v1`. A participant must match both configured identities and have state `Approved`.

Without `--api-only`, it queries each configured host's local RPC over SSH for health, identity and client version. Local RPC is used to inspect that specific process, not as a general mainnet chain-data provider. Host identity must match the configured SFDP identity. Client family is operator configuration; verify it during onboarding rather than inferring it from a version string. The `client` value selects the bounds: `agave`/`jito-agave` use `agave_*`, `firedancer` (Frankendancer) uses `firedancer_*`, and `firedancer-full` (full Firedancer, including FireBAM) uses `firedancer_full_*`; see the fleet reference's client table. A `firedancer` host reporting a full-Firedancer CalVer version (major ≥ 26), or a `firedancer-full` host reporting `0.x`, is reported as a client-mismatch `WARN` and does not pass; fix the fleet entry after verifying the host.

Compare against every returned requirement by default; the API returns the current and upcoming epochs, and the output lists every row with agave, Frankendancer and full-Firedancer bounds plus a `CHANGE from epoch N` line wherever a bound changes. Always surface upcoming changes and upcoming failures to the operator, even if the current epoch passes. `--current-only` is a legacy name: it enforces only the lowest returned requirement epoch, which may be upcoming; later rows are still evaluated and shown as `[upcoming, not enforced by --current-only]`. It does **not** independently determine the current chain epoch. Report that scope explicitly. Empty requirements or missing client bounds do not establish a pass.

Report UTC and local check time, exact identity pairs, participation, checks performed, and failures. `--api-only` does not prove installed-version compliance or host health. Never infer those from participation alone.

Exit codes: `0` means the requested checks passed (or configuration validation succeeded); `1` means configuration, API, participation, or live checks failed; `2` means invalid CLI arguments. For failures, retain the distinction between unavailable evidence and a measured noncompliant validator. These checks do not authorize upgrades or host mutations.
