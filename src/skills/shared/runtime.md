---
created: 2026-09-16
last_updated: 2026-09-30
---

# Installed bundle and operator configuration

These skills ship as a complete `sol-validator-skills` bundle: `src/skills/*`, shared code, root `package.json`/`bun.lock`, and optional `.venv`. A copied individual skill directory is not a standalone installation.

## Locate execution paths

Start with the **absolute path of the loaded SKILL.md**, resolve symlinks, and take its containing directory as `SKILL_DIR`. In the supported layout, `BUNDLE_ROOT` is three directories above `SKILL_DIR`. Verify `BUNDLE_ROOT/package.json` has name `sol-validator-skills` and that the referenced script/shared files exist. If the layout is incomplete, report the missing bundle and restore/install the full bundle; do not search the session directory for a similarly named script or run an unrelated project's commands.

For example, substitute the actual loaded path before running:

```bash
SKILL_DIR="$(dirname "$(realpath /absolute/installed/bundle/src/skills/onboarding/instructions.md)")"
BUNDLE_ROOT="$(cd "$SKILL_DIR/../../.." && pwd -P)"
bun "$SKILL_DIR/scripts/onboard.ts" status
```

Use absolute script paths with the command tool's working directory set to `BUNDLE_ROOT`. The relative commands in skill/reference examples are shorthand **after this explicit resolution**, not a requirement that the user's session has a repository. Resolve user-supplied relative input/output/config paths against the original session directory before changing command working directory. Expand literal `~`/`~/` to the user's home; reject empty overrides. Never infer a configuration path from `BUNDLE_ROOT` or session cwd.

Install dependencies with `bun install --frozen-lockfile` in `BUNDLE_ROOT` when needed. Create Python's environment with `python3 -m venv "$BUNDLE_ROOT/.venv"`, and invoke `"$BUNDLE_ROOT/.venv/bin/python"` with an absolute script path. The SFDP validator uses only the standard library. Missing Python setup must not prevent profile-only chain queries; onboarding status reports fleet validation as unchecked until Python is available.

## Discover operator configuration

| Purpose | Default path | Environment override | CLI override |
|---|---|---|---|
| Mainnet profiles | `~/.config/validator-ops/config.json` | `VALIDATOR_OPS_CONFIG` | `--config` on profile-aware commands |
| SFDP identity pairs and optional production host checks | `~/.config/validator-ops/fleet.json` | `VALIDATOR_OPS_FLEET` | SFDP `--fleet`; onboarding status `--fleet` |
| Complete host/instance layout, including backups | `~/.config/validator-ops/hosts.md` | `VALIDATOR_OPS_HOST_INVENTORY` | Explicit operator-selected path; onboarding status `--hosts` |

Precedence is explicit CLI/operator path, then the corresponding environment variable, then the user-level default. `--hosts` on status inspects the file only; it does not persist the selection for later host operations. TypeScript and Python expand `~/`; prefer absolute paths for persistent overrides. Empty overrides are errors, not a request to select the current directory. Do not automatically discover project configs or choose another fleet when a selected file is missing or invalid.

Run onboarding's `onboard.ts status` to inspect all three resolved paths without network calls. It reports profile schema validity and whether a usable RPC override or saved URL exists, and its source, validates fleet with the SFDP schema when Python is available, and checks host Markdown readability/date fields. Status reports diagnostics even if files are missing or invalid; inspect its per-file statuses rather than treating exit code zero as readiness. No status result proves live identities, host health, backup readiness or permission to mutate.

Read only the configurations needed for the current task, reuse existing entries, and ask only for missing facts. Profiles do not need fleet or hosts. SFDP participation does not need SSH or host inventory. Upgrades require reviewed `hosts.md` plus live preflight; an SFDP fleet entry is insufficient.

RPC URLs may be persisted in private operator configuration after onboarding; other secrets belong in runtime environment variables or an operator-managed secret store. A `.env` in an arbitrary session directory is not a portable credential source: load an operator-designated file explicitly or supply the environment to the process, without printing values or copying it into the installed bundle. Version 2 profiles store public identifiers and private `rpcUrl` values, with no `rpcEnv` field or execution approvals. Resolve RPC as `--rpc` → `SOLANA_RPC_URL` → selected profile URL; blank environment values fall back. Legacy version 1 environment references remain readable until explicit migration. Status reports only public fields and RPC availability/source, never URLs. Keep credential-bearing configuration outside the repository and installed bundle with mode 0600.
