---
created: 2026-03-11
last_updated: 2026-09-30
---

# Solana Validator Skills

Agent Skills for Solana validator monitoring, reward checks, bond funding and supervised upgrades. MIT licensed. Operator configuration, credentials, hosts and signers are supplied locally; none is distributed as a working default.

## Install through a skills hub

Each directory in [skills](skills/onboarding/SKILL.md) is independently installable and contains its referenced instructions, runtime helpers, dependency lock and license. Install only the workflows you need:

```bash
bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills --list
bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills --skill onboarding validator-performance --agent codex
```

The equivalent `npx skills@1.7.0 add ...` command requires the skills CLI's Node.js prerequisite. Choose another supported agent with `--agent`; add `--global` only for a user-wide installation. Other Agent Skills clients can copy an individual `skills/<name>` directory. Its runtime stays inside that directory and survives removal of the installer's temporary clone.

Ask your agent to use `onboarding` to configure a mainnet validator, then request a performance or revenue check. Each skill's local runtime guide explains dependency installation and script paths. Bun 1.3.3 is the tested runtime; Python workflows use a project virtual environment. SSH, Solana CLI, Node, Rust and validator-bonds are required only by the workflows that use them.

The published directories follow the [Agent Skills specification](https://agentskills.io/specification) and the [skills CLI discovery/install layout](https://github.com/vercel-labs/skills). Making compatible files available in GitHub does not guarantee acceptance or indexing by every hub. See [release preparation](docs/RELEASING.md).

## Workflows

| Skill | Purpose |
|---|---|
| onboarding | Mainnet profiles and SFDP identity-pair configuration |
| inventory | Host roles, paths, signer roles and failover relationships |
| validator-performance | Epoch performance and current validator status |
| validator-revenue | Historical rewards, fees and bond costs |
| jito-bam-boost | Allocation/claim checks and explicitly approved claims |
| marinade-bond-sweep | Preflight and approved funding of an existing bond |
| sfdp-check | Participation, required versions and optional host checks |
| doublezero-status | Read-only DoubleZero host diagnostics |
| votex-status | Vote-buy status and bounded on-chain fallback |
| votex-roi-sim | Bid/ROI estimates with stated assumptions |
| upgrade-agave | Upgrade an unstaked Agave or Jito-Agave backup |
| upgrade-agave-primary | Upgrade a voting Agave primary through a compatible backup |
| upgrade-testnet | Upgrade testnet Firedancer or Frankendancer |
| upgrade-mainnet | Upgrade a Firedancer primary through a compatible Agave backup |

## Configuration and operating boundaries

Defaults are `~/.config/validator-ops/config.json` for profiles, `fleet.json` for SFDP pairs and `hosts.md` for host inventory. Explicit CLI/environment overrides take precedence. Configuration is independent of the session directory and installation method.

Onboarding persists your verified Helius mainnet URL in private user configuration. Mainnet helpers resolve `--rpc` → nonblank `SOLANA_RPC_URL` → the selected/default/sole profile's saved URL. Legacy custom RPC environment references remain supported until explicit onboarding migration. Never paste credentials into chat or commit them. Testnet and process-local RPC checks retain explicit network/instance context. Chain queries do not require SSH or signers.

Read-only checks do not authorize transactions or restarts. Mutation workflows require a concrete plan, scoped authorization and fresh state checks. Upgrade skills are supervised runbooks: verify actual installed CLI behavior, supervisor, identities and tower compatibility. Preserve single-instance voting and fresh towers on handoff. Installation tests never require a production transaction or restart.

Historical figures and ROI estimates depend on source availability and assumptions. Unavailable data must remain visible; an incomplete query is not evidence of zero activity.

## Develop or use a pinned checkout

```bash
git clone https://github.com/roborun-xyz/sol-validator-skills.git
cd sol-validator-skills
bun install --frozen-lockfile
python3 -m venv .venv
bun run onboard --help
bun run performance --profile my-validator
bun run skills:build
bun run validate
bun run test:install
```

Author skill instructions and helper code in `src/skills`; `instructions.md` is the source for a published `SKILL.md`. The generator produces standard `skills/<name>` folders with only their required runtime components and local reference copies. Do not edit generated files manually. See [contributing](CONTRIBUTING.md) and [validation](docs/VALIDATION.md).

A private operator repository may pin this repository as a Git submodule and link its agent entrypoints to `skills/<name>`. Keep all reusable implementation here and operational evidence/configuration in the consumer. The consumer must not be required for another operator to install or run a skill.
