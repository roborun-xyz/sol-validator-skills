---
name: jito-bam-boost
description: Check and claim Jito BAM Boost JitoSOL rewards for a Solana mainnet validator identity. Use when an operator asks what BAM Boost is claimable, whether a BAM allocation was claimed, or explicitly asks to claim an exact BAM reward; do not use for ordinary Jito MEV rewards.
license: MIT
compatibility: Requires Bun 1.3.3, internet access and a mainnet RPC URL. Approved claims also require Git, Cargo, Solana CLI and an operator-owned local signer.
metadata:
  created: "2026-08-29"
  last_updated: "2026-10-08"
---

# Jito BAM Boost

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Apply [RPC setup and selection](../shared/runtime.md#discover-operator-configuration); repair missing URLs through [onboarding](../onboarding/instructions.md), then resume the requested task. No RPC credential is bundled.

Check BAM Boost allocations read-only by default. Claim only after the operator explicitly approves the exact identity, claim epoch, and JitoSOL amount. The validator identity is the claimant, transaction signer, fee payer, and destination token-account owner.

## Resolve the validator

1. Use `--profile NAME` (or the selected default profile) for a current validator. If no profile is configured, follow `../onboarding/instructions.md` and resume the query. The checker verifies the live vote/identity relationship and uses the shared RPC precedence.
2. Use `--identity PUBKEY` only for an explicitly identified claimant. Historical identities need not still be active validators. Host aliases are not accepted. `--profile NAME --identity PUBKEY` uses the shared RPC selection but queries the explicit claimant without changing the profile.
3. For a claim, re-check relevant live state and request the path of the identity keypair already held on the operator machine. Never retrieve a signer from a validator host or guess another operator's path.
4. Validate the local keypair with `solana-keygen pubkey`; never print, parse, copy, or store its contents. The pubkey must equal the approved claimant identity.

## Install the checker dependencies

From the resolved bundle root, run `bun install --frozen-lockfile` when `node_modules` is absent. Do not replace Bun with npm or another runtime.

Claims additionally require local `git`, Rust/Cargo with a linker/build toolchain, and `solana-keygen`. The wrapper builds the pinned official CLI; read-only allocation checks need only Bun and the repository dependencies. Complete dependency setup before planning a signed transaction.

## Read-only check

Run from the resolved bundle root:

```bash
bun src/skills/jito-bam-boost/scripts/check.ts \
  --profile my-validator \
  --format markdown
```

The checker obtains the published mainnet claim epochs from Jito's public GCS bucket, reads each Merkle allocation, derives the official distributor and Claim Status PDAs, and checks finalized state through the operator-selected mainnet RPC. A positive allocation is claimable only when all of these are true:

- no Claim Status account exists;
- the distributor account exists;
- its JitoSOL token account exists and holds at least the allocation amount.

Report raw JitoSOL and its current official JitoSOL/SOL equivalent. Keep the raw amount authoritative: claiming transfers JitoSOL, not native SOL. For historical revenue valuation by earning epoch, use `validator-revenue` instead.

Use `--claim-epoch <N>` to inspect one distributor. JSON is available with `--format json`. Never infer claimability solely from an absent Claim Status: old distributors can be empty or closed.

## Approval gate

If nothing is claimable, report the finalized result and stop. Otherwise present one concise plan with:

- UTC and local check time;
- validator identity and validated local keypair path;
- each claim epoch and exact amount in JitoSOL lamports and JitoSOL;
- current official SOL equivalent and rate timestamp;
- distributor, Claim Status, and destination JitoSOL token-account addresses;
- identity SOL balance, and whether the destination token account already exists;
- the pinned official CLI commit used below.

Ask for explicit approval immediately before signing. Approval is valid only for the displayed identity, claim epochs, and exact lamport amounts. Re-check and request fresh approval if any allocation, address, signer, funding state, or amount changes.

## Claim

The bundled wrapper pins Jito's official `jito-bam-boost-cli` source to commit `1fbca8059eb13f6120b12b8b77d51dfb1013a2d6`, verifies the checkout, builds it with Cargo's lockfile, repeats the finalized preflight, and refuses to submit unless the exact approved lamport amount matches.

The claim wrapper takes an explicit identity and supports the same RPC/config/profile selection as discovery. Use the same endpoint for discovery and claim without displaying credentials. After approval, claim one epoch at a time from the local operator machine:

```bash
bun src/skills/jito-bam-boost/scripts/claim.ts \
  --identity "$APPROVED_IDENTITY" \
  --claim-epoch "$APPROVED_CLAIM_EPOCH" \
  --expected-amount-lamports "$APPROVED_AMOUNT_LAMPORTS" \
  --keypair "$LOCAL_IDENTITY_KEYPAIR" \
  --execute
```

Do not use the pinned CLI's `--print-tx` flag as a simulation path: that version still submits the transaction. Do not use `--skip-preflight`, SSH, a remote keypair, a different BAM program, or an RPC endpoint other than the one the read-only check used.

For multiple approved epochs, run them in ascending order and stop after the first failure or ambiguous result. Do not retry until the transaction signature and finalized Claim Status have been resolved.

## Verify and report

The wrapper requires finalized post-verification. It polls the finalized Claim Status and destination token account read-only for a bounded period after the CLI returns and never resubmits; a Claim Status that does not match the approved claim fails at once. Report:

- UTC and local completion time;
- transaction signature;
- identity, claim epoch, and distributor;
- JitoSOL balance before and after, with the exact delta;
- finalized Claim Status address and state;
- raw JitoSOL claimed and the current SOL equivalent used for display.

If submission succeeds but post-verification differs from the approved amount, report the discrepancy and stop. Never submit a compensating or duplicate transaction.
