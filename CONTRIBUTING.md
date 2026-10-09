---
created: 2026-09-15
last_updated: 2026-10-08
---

# Contributing

Install the pinned Bun dependencies and create the project Python virtual environment. Author changes in `src/skills`, then run `bun run skills:build` and `bun run validate`. Run `bun run test:install` for packaging changes. Tests must not submit transactions, use real signers, restart validators or require operator credentials.

Each skill's `instructions.md` has Agent Skills frontmatter: a matching lowercase name, a concise trigger description, MIT license, relevant environment requirements and string-valued metadata dates. The generated `skills/<name>/SKILL.md` is its public entrypoint. Keep essential constraints in the entrypoint and task-specific details in linked references. Local references must resolve inside an independently installed skill.

Share source code and procedures under `src/skills/shared`. The generator copies the needed components into each skill's own runtime and writes an index at `skills/README.md`. Update `runtime/package.json` and its lock when runtime dependencies change; root dependencies support development. Generated copies must match their source. Do not add install hooks, operator defaults or implicit production actions.

Review new source files and list them in `release-files.json`; `skills:build` maintains the generated-file entries. The release audit checks names, dates, links, selected secret patterns, exported paths and tracked files omitted from the allowlist. It supplements manual review rather than proving the absence of every secret. Keep credentials, keypairs, private host inventory and raw provider errors out of code, issues and public logs.

Use Conventional Commits and separate unrelated scopes. Preserve Markdown creation dates and update modification dates. Tests should verify observable behavior, failure boundaries and ambiguous results. Mutations need preflight checks before the first side effect; configuration and read-only requests never imply execution approval.

## Releasing

```bash
bun install --frozen-lockfile
python3 -m venv .venv
bun run skills:build
bun run validate
bun run test:install
bun tooling/release.ts --output /absolute/path/to/new-release-directory
```

The exporter copies only allowlisted files, refuses an existing destination and symlinks, and writes SHA-256 metadata. It excludes Git history, operator data, installed dependencies and environment files. Run the same validation in the exported tree before tagging.

`skills/<name>` directories on `main` are the installation units; the skills CLI installs them straight from GitHub, so a merged commit is already installable. Tag a release only from a commit whose CI is green, and describe the reviewed fixes and known limitations in the release notes. Consumers that pin this repository as a submodule should pin a tagged commit.

## Demo recording

`docs/demo.gif` is produced by [VHS](https://github.com/charmbracelet/vhs) from `docs/demo.tape`. Re-record after a change that alters the install flow or the revenue report:

```bash
brew install vhs
export SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...   # never committed
vhs docs/demo.tape
```

The tape installs from the public repository into a throwaway directory under `/tmp`, so record it after the change it should show has reached `main`. The vote account it onboards is public; edit the tape to show another. The `claude` call passes `--setting-sources project`, so your personal `~/.claude` instructions and settings do not shape the recorded session.
