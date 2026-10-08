---
name: marinade-bond-sweep
description: Sweep surplus SOL from a Solana mainnet validator vote account and identity account into its existing Marinade Validator Bond using keypairs held on the local operator machine. Use when funding a validator's Marinade bond while retaining vote-account rent exemption and at least 5 SOL in the identity.
license: MIT
compatibility: Requires Bun 1.3.3, Node.js >=20.18.0, Solana CLI, validator-bonds CLI 2.6.0 and a mainnet RPC URL. Execution requires operator-owned local signers.
metadata:
  created: "2026-08-24"
  last_updated: "2026-10-08"
---

# Marinade Bond Sweep

Read [installed bundle and configuration](references/shared-runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Sweep a mainnet validator's vote-account and identity-account surplus into its existing Marinade bond. Run discovery, preflight, simulation, signing, submission, and verification from the local operator machine; the validator host is not a signing environment for this workflow. Use the bundled two-phase executor so independent preflight checks run in parallel and balance-only drift does not create a second approval loop. This is a production mutation: complete the read-only phase, show its exact plan, and wait for explicit operator approval before starting the execution phase.

## Local prerequisites

Install the repository's Bun dependencies, and ensure `solana` and `solana-keygen` are available in the local runtime. Solana CLI 3.1.9 is the locally checked reference; inspect withdrawal/confirmation flags for other releases before signing. The executor requires validator-bonds CLI 2.6.0 and Node.js >=20.18.0 on PATH (the pinned CLI uses a Node interpreter even when installed with Bun):

```bash
bun add --global @marinade.finance/validator-bonds-cli@2.6.0
validator-bonds --version
```

Ensure the Bun global binary directory is on PATH. Preflight checks required `fund-bond-sol` flags and refuses a different validator-bonds version. No local signers are needed to install tools or view `--help`.

## Fixed policy

- Apply [RPC setup and selection](references/shared-runtime.md#discover-operator-configuration). Both planner and executor accept `--rpc`, `--config`, and `--profile`; never print or commit API keys.
- Operate only on an existing bond. Never initialize, configure, withdraw from, or otherwise change a bond.
- The executor accepts only a bond whose authority is the validator identity and whose withdrawal state is empty; any other bond is rejected in preflight. Do not work around that check for a bond with a separate authority.
- Vote account: when its finalized total balance is below `1 SOL`, skip it. Otherwise withdraw `ALL` to the validator identity; Solana CLI's vote-account `ALL` semantics leave the rent-exempt minimum.
- Identity account: evaluate its finalized balance independently before moving vote funds. The hard floor is `5 SOL`; use a `5.001 SOL` execution reserve because an active validator identity can continue paying vote fees while the transaction is simulated and finalized. Below `5 SOL`, contribute none of its original balance. At or below `5.001 SOL`, contribute none. Above `5.001 SOL`, contribute exactly `balance - 5.001 SOL`.
- Require every nonzero sweep to leave at least `5 SOL` in the identity. If the identity starts below `5 SOL`, reject an otherwise eligible vote sweep during read-only planning, before any withdrawal. A below-floor identity with no eligible surplus can still produce a no-op result. Do not retain part of the vote surplus to top up the identity under this policy.
- Withdraw any eligible vote surplus temporarily to the identity, then fund the bond once with `vote surplus + identity surplus`. This returns an identity that started above `5.001 SOL` to the operational reserve before concurrent vote fees; an identity that started between `5 SOL` and the reserve returns to its unchanged starting balance.
- Use a fee-payer keypair whose pubkey differs from the validator identity. This keeps transaction fees from reducing the identity below the `5 SOL` target.
- Never expose, print, copy, or store keypair contents. Use only keypair files already present on the local operator machine.
- Never SSH to a validator host to discover or use a signer, and never fall back to a validator-host key path when a local signer is missing.
- Do not use `--skip-preflight`. Require `finalized` confirmation.
- Never invoke the executor's `--execute` mode before showing the current read-only result and receiving explicit operator confirmation. A request to inspect, plan, or preflight is not execution approval.

## Resolve the validator

1. Resolve the requested validator from an explicit vote account or the operator's chain profile (`references/onboarding.md`). Reuse verified public keys and pass them explicitly to the executor. A profile or host key path is not evidence that a local signer is available.
2. Re-check the vote account through the configured mainnet RPC and derive both the live identity and current authorized-withdrawer from its finalized state. Do not use a testnet validator, an unstaked/warmup identity, a stale inventory value, or an ambiguous host.
3. Discover these three signer roles on the local operator machine without reading keypair contents:
   - current validator identity keypair;
   - current vote authorized-withdrawer keypair;
   - a fee-payer keypair whose pubkey differs from the validator identity.
4. Ask for local signer paths or use paths explicitly provided earlier by this operator. Search only operator-designated local key directories by filename when needed; do not scan unrelated logs or other operators' inventories. Keep paths in operator-owned configuration outside the repository and never print or parse JSON key material. See `references/inventory-references-hosts.md` for signer onboarding.
5. Require each selected local file to be readable and compare its `solana-keygen pubkey` output with the expected on-chain pubkey. Do not trust a filename alone. The authorized-withdrawer keypair may also be the fee payer only when its pubkey differs from the identity and its finalized balance is sufficient for the planned transactions.
6. If any required local keypair cannot be found or validated, pause and tell the operator which signer role and expected pubkey are missing. Do not SSH to the validator host, fetch a remote key, copy a key between machines, or guess a path.

## Phase 1: read-only preflight

From the resolved bundle root, run the bundled executor without `--execute`:

```bash
bun src/skills/marinade-bond-sweep/scripts/execute.ts \
  --vote-account "$VOTE_ACCOUNT" \
  --identity "$IDENTITY_ACCOUNT" \
  --identity-keypair "$IDENTITY_KEYPAIR" \
  --withdrawer-keypair "$VOTE_WITHDRAWER_KEYPAIR" \
  --fee-payer-keypair "$FEE_PAYER_KEYPAIR"
```

This mode cannot mutate chain state. It runs the finalized planner, bond lookup, signer checks, fee-payer balance check, and local tooling checks in parallel. It emits one JSON result containing the accounts, balances, action path, signer paths, exact proposed funding, `5.001 SOL` reserve, default `proposed + 0.1 SOL` ceiling, and an `approvalId` bound to the non-balance state and ceiling.

Do not repeat the planner or `show-bond` serially when this result succeeds. Use extra read-only commands only to diagnose a failed or ambiguous preflight.

A rejected plan reports the finalized vote, rent-reserve and identity balances it was decided on; relay them with the rejection.

If no mutation is proposed, report the result and stop. Otherwise present the JSON result concisely, including UTC and local check time, all accounts and signer paths, vote and identity actions, proposed funding, approval ceiling, and the warning that vote withdrawal can succeed even if later funding fails. Ask for explicit approval of that exact `approvalId` and ceiling, then stop and wait. Never continue to Phase 2 in the same turn without the operator's confirmation.

## Phase 2: execute after confirmation

Only after explicit confirmation, run the same local command with the approved values:

```bash
bun src/skills/marinade-bond-sweep/scripts/execute.ts \
  --vote-account "$VOTE_ACCOUNT" \
  --identity "$IDENTITY_ACCOUNT" \
  --identity-keypair "$IDENTITY_KEYPAIR" \
  --withdrawer-keypair "$VOTE_WITHDRAWER_KEYPAIR" \
  --fee-payer-keypair "$FEE_PAYER_KEYPAIR" \
  --execute \
  --operator-approved \
  --approval-id "$APPROVAL_ID" \
  --approved-ceiling-lamports "$APPROVED_CEILING_LAMPORTS"
```

The executor re-runs one parallelized finalized preflight and refuses to sign unless the approval fingerprint, accounts, signer roles, bond, action path, withdrawal state, and ceiling still match. It then performs the approved workflow as one state machine:

1. withdraw eligible vote surplus and verify the finalized vote balance equals its rent reserve;
2. accept identity balance drift, recalculate the funding amount, and continue without another approval only while the amount stays within the approved ceiling and preserves the original contribution policy;
3. re-check the bond has no withdrawal request;
4. simulate the exact recalculated funding transaction;
5. re-read the identity and require the same amount to leave at least the `5 SOL` hard floor;
6. submit that exact amount at finalized commitment;
7. resolve the funding signature from the configured mainnet RPC and verify the `FundBond` transaction, funded stake account, the identity balance that transaction left against the `5 SOL` hard floor, vote rent reserve, bond ownership increase, and withdrawal state.

After each submission the executor polls its read-only verification (signature status, vote and identity balances, bond ownership) for a bounded period, so a lagging RPC node is not reported as a failed mutation. It never repeats a submission. Funding is sized only from an identity balance that already includes the withdrawal. Only transport failures and a few failed `show-bond` reads are retried; a validation failure is reported at once.

The hard floor is checked against the identity balance recorded in the funding transaction (`identityBalanceAfterFundingLamports`). The later `after.identityBalanceLamports` read keeps falling as the identity pays vote fees and can be slightly below `5 SOL`; that is not a floor violation.

Do not replace this flow with manual commands after a successful Phase 1. Do not use `solana confirm -v`, because it prints the configured RPC URL; use the executor's redacted RPC verification.

Balance-only drift below the approved ceiling does not require a second approval. Stop and obtain a new read-only plan and explicit approval if the approval fingerprint changes, the action path changes before execution, funding exceeds the ceiling, a signer or account changes, a withdrawal request appears, simulation fails, or the identity hard floor would be violated.

## Report and record

Report the executor's UTC and local completion time, before/after balances in lamports and SOL, skipped actions, bond change, funded stake account, and both transaction signatures. Use its final JSON rather than making duplicate RPC calls. If a durable Markdown operation record exists for that validator, update it from this result while preserving `created` and setting `last_updated` in frontmatter.

## Failure handling

- If vote withdrawal succeeds but funding fails, stop. Report that the surplus is now in the identity and include the finalized balances and vote-withdrawal signature. Never retry or improvise without a fresh plan and approval.
- If RPC submission returns an ambiguous error, resolve the transaction signature and finalized status before considering any retry.
- If balance drift would exceed the approved funding ceiling or consume the execution buffer and put the identity below the hard floor, stop and request a fresh approval; do not improvise another amount automatically.
- If the funding transaction left the identity below the `5 SOL` hard floor, report it as a safety failure immediately and do not perform another debit.
