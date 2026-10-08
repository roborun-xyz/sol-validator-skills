---
created: 2026-03-11
last_updated: 2026-10-08
---

# Solana Validator Skills

Agent Skills for running a Solana validator from Claude Code, Codex or any other Agent Skills client. Ask your agent for a performance review, a per-epoch revenue breakdown, your JitoSOL Steward rank or your SFDP standing, and it runs the bundled helpers against mainnet and reports with every assumption stated. Anything that signs a transaction or restarts a validator is gated behind an exact plan that you approve first.

![Fresh install, onboarding and a revenue check](docs/demo.gif)

## Install

```bash
# See what is available
bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills --list

# Install the skills you want for the agent you use
bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills \
  --skill onboarding validator-performance validator-revenue \
  --agent claude-code
```

Then tell your agent: *"Use onboarding to set up my validator, then give me a 30-epoch performance review."*

Requirements are Bun 1.3.3 and a mainnet RPC URL for chain queries: any http or https endpoint works, and Helius is the tested default. SSH, Solana CLI, Rust and Python are needed only by the workflows that use them; each `SKILL.md` says which. `npx skills@1.7.0 add ...` works the same way. Any other Agent Skills client can copy a [`skills/<name>`](skills/README.md) directory: each one carries its own runtime, dependency lock and license.

## What a check looks like

`validator-performance`, five completed epochs, under one second:

> Current epoch `1052` — slot 173,236 / 432,000 (40.10%).
> Node identity `Fc6NNdS2j3EmrWbU6Uqt6wsKB5ef72NjaWfNxKYbULGD`, delinquent `no`, activated stake `3,973,470 SOL`, live commission `5%`.
>
> | Epoch | Stake SOL | Vote Credits | TVC % | TVC Rank | Blocks | Block Prod % | Skip Rate | Commission | MEV Comm |
> |---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
> | 1047 | 3,994,579 | 6,903,974 | 99.88% | #454 | 4,108/4,108 | 100.00% | 0.00% | 5% | 8% |
> | 1048 | 4,033,160 | 6,906,950 | 99.93% | #506 | 3,900/3,900 | 100.00% | 0.00% | 5% | 8% |
> | 1049 | 4,004,541 | 6,903,545 | 99.88% | #512 | 3,884/3,884 | 100.00% | 0.00% | 5% | 8% |
> | 1050 | 4,024,391 | 6,899,719 | 99.82% | #484 | 4,104/4,104 | 100.00% | 0.00% | 5% | 8% |
> | 1051 | 3,934,965 | 6,908,434 | 99.95% | #495 | 4,052/4,052 | 100.00% | 0.00% | 5% | 8% |
>
> Window summary: total vote credits `34,522,622`, avg TVC `99.89%`, block production `20,048 / 20,048`, avg skip rate `0.00%`.

`validator-revenue` goes further: per-epoch gross and net SOL from inflation and commission rewards, Jito MEV commission computed from Jito's official validator rewards, BAM Boost allocations valued at the historical JitoSOL/SOL rate, voting fees and Marinade bond costs, followed by a reconciliation table that shows every rate, timestamp and excluded inflow it used. Every helper also emits CSV and JSON.

## Skills

| Skill | What it does |
|---|---|
| **Monitoring** | |
| [validator-performance](skills/validator-performance/SKILL.md) | Vote credits, TVC rank, skip rate, block production, stake and commission by epoch |
| [validator-revenue](skills/validator-revenue/SKILL.md) | Gross and net SOL by epoch: rewards, Jito MEV, BAM Boost, fees, Marinade bond costs |
| [jitosol-steward](skills/jitosol-steward/SKILL.md) | JitoSOL Steward rank, delegation fraction, active and transient stake |
| [sfdp-check](skills/sfdp-check/SKILL.md) | SFDP participation, required versions, optional host checks over SSH |
| [doublezero-status](skills/doublezero-status/SKILL.md) | DoubleZero Edge client, BGP tunnel and multicast diagnostics on your hosts |
| [votex-status](skills/votex-status/SKILL.md) | Votex / The Vault vote-buy status with on-chain fallback |
| [votex-roi-sim](skills/votex-roi-sim/SKILL.md) | Vote-buy ROI and break-even sizing with stated assumptions |
| **Rewards and bonds** | |
| [jito-bam-boost](skills/jito-bam-boost/SKILL.md) | Check claimable BAM Boost JitoSOL; claim only an exact approved amount |
| [marinade-bond-sweep](skills/marinade-bond-sweep/SKILL.md) | Preflight and approved funding of an existing Marinade validator bond |
| **Operations** | |
| [onboarding](skills/onboarding/SKILL.md) | Local validator profiles, RPC configuration, SFDP identity pairs |
| [inventory](skills/inventory/SKILL.md) | Host roles, paths, signer roles and failover relationships |
| [upgrade-agave](skills/upgrade-agave/SKILL.md) | Upgrade an unstaked Agave or Jito-Agave backup |
| [upgrade-agave-primary](skills/upgrade-agave-primary/SKILL.md) | Upgrade a voting Agave primary through a compatible backup |
| [upgrade-mainnet](skills/upgrade-mainnet/SKILL.md) | Upgrade a Firedancer primary through an Agave backup |
| [upgrade-testnet](skills/upgrade-testnet/SKILL.md) | Upgrade testnet Firedancer or Frankendancer |

## How it stays safe

- **Read-only by default.** Monitoring skills never touch SSH or signers. Chain queries use your RPC URL and public data sources.
- **Mutations need an exact plan.** A claim or bond sweep prints the identity, amounts and addresses, asks for approval, re-checks finalized state, and refuses to submit if anything changed. It never retries or sends a compensating transaction on its own.
- **Signers stay on your machine.** Helpers validate a keypair with `solana-keygen pubkey` and never read, copy or print its contents. Nothing fetches a signer from a validator host.
- **Upgrades are supervised runbooks.** Fail over through a verified unstaked backup, carry the freshly written tower, promote with `--require-tower`, and verify single-instance voting on chain before calling it done.
- **Missing data stays visible.** An unavailable epoch is reported as unavailable, never as zero. An incomplete scan fails instead of producing a partial window.
- **No credentials in the repo.** Your RPC URL lives in `~/.config/validator-ops/` with mode 0600. The release audit rejects embedded keys, private key material and operator paths.

## Data sources

| Source | Used for |
|---|---|
| Your mainnet RPC (any endpoint; Helius tested) | Current epoch, vote accounts, finalized account state, transaction scans |
| [SVT](https://svt.one) validator history | Per-epoch credits, rank, rewards, stake and leader slots |
| [Trillium](https://trillium.so) | Epoch-specific identity for BAM Boost attribution |
| Jito kobe API and BAM Boost bucket | Official validator MEV rewards, JitoSOL/SOL ratio, Merkle allocations |
| Jito StakeNet steward accounts (on chain) | Steward rank and delegation state |
| Marinade validator-bonds and scoring APIs | Bond payments and SAM bids |
| Solana Foundation community API | SFDP participation and required versions |
| VotaFi tribeca-stats, SolanaVault stakebot-data, Jupiter price | Votex vote-buy status and ROI inputs |

Historical figures depend on these sources being available. Each helper names what it could not fetch.

## Configuration

Profiles live in `~/.config/validator-ops/config.json`, SFDP identity pairs in `fleet.json` and host inventory in `hosts.md`. Override any of them with `--config`, `--fleet`, `--hosts` or the matching `VALIDATOR_OPS_*` environment variable. RPC resolution is `--rpc`, then `SOLANA_RPC_URL`, then the selected profile's saved URL. Configuration never grants execution approval; every mutation runs its own live preflight.

## Develop

```bash
git clone https://github.com/roborun-xyz/sol-validator-skills.git
cd sol-validator-skills
bun install --frozen-lockfile
python3 -m venv .venv
bun run performance --vote-account <VOTE_ACCOUNT> --epochs 5
bun run validate        # tests, typecheck, generated-file and release checks
bun run test:install    # installs every skill with the skills CLI into a temp project
```

Author instructions and helpers in `src/skills`; `bun run skills:build` generates the installable `skills/<name>` directories. See [CONTRIBUTING](CONTRIBUTING.md), [validation scope](docs/VALIDATION.md) and the [dependency audit](docs/DEPENDENCY_AUDIT.md).

MIT licensed. Built by validator operators, for validator operators.
