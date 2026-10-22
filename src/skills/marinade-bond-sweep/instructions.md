---
name: marinade-bond-sweep
description: Keep a Solana mainnet validator's vote account funded for Alpenglow's per-epoch VAT, then sweep remaining vote-account and identity surplus into its existing Marinade Validator Bond using keypairs held on the local operator machine. Use when funding a validator's Marinade bond while retaining a vote-account reserve (default 3 SOL) and at least 5 SOL in the identity.
license: MIT
compatibility: Requires Bun 1.3.3, Node.js >=20.18.0, Solana CLI, validator-bonds CLI 2.6.0 and a mainnet RPC URL. Execution requires operator-owned local signers.
metadata:
  created: "2026-08-24"
  last_updated: "2026-10-22"
---

# Marinade Bond Sweep

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

Keep a mainnet validator's vote account funded, then sweep the remaining vote-account and identity-account surplus into its existing Marinade bond. Run discovery, preflight, simulation, signing, submission, and verification from the local operator machine; the validator host is not a signing environment for this workflow. Use the bundled two-phase executor so independent preflight checks run in parallel and balance-only drift does not create a second approval loop. This is a production mutation: complete the read-only phase, show its exact plan, and wait for explicit operator approval before starting the execution phase.

## Local prerequisites

Install the repository's Bun dependencies, and ensure `solana` and `solana-keygen` are available in the local runtime. Solana CLI 3.1.9 is the locally checked reference; inspect withdrawal/confirmation flags for other releases before signing. The executor requires validator-bonds CLI 2.6.0 and Node.js >=20.18.0 on PATH (the pinned CLI uses a Node interpreter even when installed with Bun):

```bash
bun add --global @marinade.finance/validator-bonds-cli@2.6.0
validator-bonds --version
```

Ensure the Bun global binary directory is on PATH. Preflight checks required `fund-bond-sol` flags and refuses a different validator-bonds version. No local signers are needed to install tools or view `--help`.

## Why the vote account keeps a reserve (Alpenglow)

Mainnet runs Alpenglow since epoch 1064 (2026-10-21). Vote transactions and vote fees no longer exist, so the identity no longer pays vote fees. Instead, at each epoch start a validator admission tax (VAT) of `0.8 SOL` is debited from the **vote account** (reported as reward type `VATDebit`) to admit the validator for the next epoch. If the vote account cannot cover its rent-exempt minimum plus `0.8 SOL`, the validator is not admitted: no votes, no blocks, no rewards for the epoch. Withdrawing a vote account down to rent exemption therefore risks the validator not being admitted.

This skill reverses the old priority: the vote account is kept at a reserve first, and only what is left funds the bond. Block revenue may also accrue to the vote account (SIMD-0232), so its balance can grow during a run.

## Fixed policy

- Apply [RPC setup and selection](../shared/runtime.md#discover-operator-configuration). Both planner and executor accept `--rpc`, `--config`, and `--profile`; never print or commit API keys.
- Operate only on an existing bond. Never initialize, configure, withdraw from, or otherwise change a bond.
- The executor accepts only a bond whose authority is the validator identity and whose withdrawal state is empty; any other bond is rejected in preflight. Do not work around that check for a bond with a separate authority.
- Vote reserve: default `3 SOL`, set with `--vote-reserve-sol` on both planner and executor. Planner and executor refuse any reserve below `rent-exempt minimum + 0.8 SOL VAT + 0.1 SOL margin`. The reserve is part of the approval fingerprint.
- Identity: the hard floor is `5 SOL`; the `5.001 SOL` execution reserve adds headroom for identity-signed operations and transaction fees. Identity surplus is `balance - 5.001 SOL` when positive, otherwise zero. An identity below `5 SOL` contributes nothing.
- Step 1, vote top-up: when the finalized vote balance is below the reserve, move `min(reserve - vote balance, identity surplus)` from the identity to the vote account with a plain System transfer signed by the identity (depositing into a vote account needs no vote authority). If the identity surplus cannot cover the deficit, the plan is `top-up-partial` and reports the remaining `voteShortfall`; execution then also requires `--accept-vote-shortfall`, given only after the operator explicitly accepts the shortfall. With no identity surplus the plan is `shortfall-no-surplus`: nothing moves, and the shortfall must be reported prominently because the validator risks not being admitted at the next epoch start.
- Step 2, bond funding: when the vote balance is above the reserve by at least `0.1 SOL`, withdraw exactly that excess (an explicit lamport amount, never `ALL`) to the identity with the authorized withdrawer, then fund the bond once with `vote excess + identity surplus`. After a top-up, only the identity surplus that remains funds the bond. A top-up and a vote withdrawal never occur in the same plan.
- Require every nonzero sweep to leave at least `5 SOL` in the identity. If the identity starts below `5 SOL`, reject an otherwise eligible vote withdrawal during read-only planning, before any mutation. Do not retain part of the vote excess to top up the identity under this policy.
- Use a fee-payer keypair whose pubkey differs from the validator identity. Every transaction fee is paid by it, so fees never reduce the identity or the vote account.
- Never expose, print, copy, or store keypair contents. Use only keypair files already present on the local operator machine.
- Never SSH to a validator host to discover or use a signer, and never fall back to a validator-host key path when a local signer is missing.
- Do not use `--skip-preflight`. Require `finalized` confirmation.
- Never invoke the executor's `--execute` mode before showing the current read-only result and receiving explicit operator confirmation. A request to inspect, plan, or preflight is not execution approval.

## Resolve the validator

1. Resolve the requested validator from an explicit vote account or the operator's chain profile (`../onboarding/instructions.md`). Reuse verified public keys and pass them explicitly to the executor. A profile or host key path is not evidence that a local signer is available.
2. Re-check the vote account through the configured mainnet RPC and derive both the live identity and current authorized-withdrawer from its finalized state. Do not use a testnet validator, an unstaked/warmup identity, a stale inventory value, or an ambiguous host.
3. Discover these three signer roles on the local operator machine without reading keypair contents:
   - current validator identity keypair;
   - current vote authorized-withdrawer keypair;
   - a fee-payer keypair whose pubkey differs from the validator identity.
4. Ask for local signer paths or use paths explicitly provided earlier by this operator. Search only operator-designated local key directories by filename when needed; do not scan unrelated logs or other operators' inventories. Keep paths in operator-owned configuration outside the repository and never print or parse JSON key material. See `../inventory/references/hosts.md` for signer onboarding.
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

This mode cannot mutate chain state. It runs the finalized planner, bond lookup, signer checks, fee-payer balance check, and local tooling checks in parallel. It emits one JSON result containing the accounts, balances, action path, signer paths, vote reserve and its minimum, proposed vote top-up and any shortfall, exact proposed funding, `5.001 SOL` identity reserve, default `proposed + 0.1 SOL` funding and top-up ceilings, and an `approvalId` bound to the non-balance state, reserve and ceilings.

Do not repeat the planner or `show-bond` serially when this result succeeds. Use extra read-only commands only to diagnose a failed or ambiguous preflight.

A rejected plan reports the finalized vote, rent-exemption, vote-reserve and identity balances it was decided on; relay them with the rejection.

If no mutation is proposed, report the result and stop; for `shortfall-no-surplus`, state the vote shortfall and the admission risk first. Otherwise present the JSON result concisely, including UTC and local check time, all accounts and signer paths, vote reserve, vote and identity actions, vote top-up and shortfall, proposed funding, both approval ceilings, and the warning that a vote top-up or withdrawal can finalize even if later funding fails. For `top-up-partial`, ask separately whether the operator accepts the remaining shortfall. Ask for explicit approval of that exact `approvalId` and ceiling, then stop and wait. Never continue to Phase 2 in the same turn without the operator's confirmation.

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
  --approved-ceiling-lamports "$APPROVED_CEILING_LAMPORTS" \
  --approved-top-up-ceiling-lamports "$APPROVED_TOP_UP_CEILING_LAMPORTS"
```

Pass the same `--vote-reserve-sol` used in Phase 1 when it was not the default. Add `--accept-vote-shortfall` only for an approved `top-up-partial` plan.

The executor re-runs one parallelized finalized preflight and refuses to sign unless the approval fingerprint, accounts, signer roles, bond, action path, withdrawal state, and ceiling still match. It then performs the approved workflow as one state machine:

1. vote top-up (top-up plans only): re-read vote and identity at finalized commitment, recompute `min(deficit, identity surplus)`, skip it when that is zero (for example, the vote balance already grew to the reserve), refuse it above the approved top-up ceiling or when it newly leaves a shortfall without `--accept-vote-shortfall`, simulate the unsigned System transfer, submit with `solana transfer` at finalized commitment, then wait until the finalized vote balance includes it and the identity remains at or above `5 SOL`;
2. vote withdrawal (`withdraw-excess` plans only): re-read at finalized commitment, withdraw `min(current excess, approved excess)` as an explicit amount (skipping when it is zero; growth from block revenue stays in the vote account), simulate it, submit, wait until the identity includes it, and assert the finalized vote balance is at least the reserve;
3. re-read vote and identity, recalculate the funding amount, and continue without another approval only while it stays within the approved ceiling and preserves the original contribution policy; refuse bond funding if the vote balance is below its reserve;
4. re-check the bond has no withdrawal request;
5. simulate the exact recalculated funding transaction;
6. re-read the identity and require the same amount to leave at least the `5 SOL` hard floor;
7. submit that exact amount at finalized commitment;
8. resolve the funding signature from the configured mainnet RPC and verify the `FundBond` transaction, funded stake account, the identity balance that transaction left against the `5 SOL` hard floor, bond ownership increase, and withdrawal state. A final vote balance below the reserve (only possible through an epoch-start VAT debit during the run) is reported as a warning.

After each submission the executor polls its read-only verification (signature status, vote and identity balances, bond ownership) for a bounded period, so a lagging RPC node is not reported as a failed mutation. It never repeats a submission. Bond funding never starts before the vote step has finalized and been re-read, and it is sized only from an identity balance that already includes the withdrawal or top-up. Only transport failures and a few failed `show-bond` reads are retried; a validation failure is reported at once.

The hard floor is checked against the identity balance recorded in the funding transaction (`identityBalanceAfterFundingLamports`). Under Alpenglow the identity no longer pays vote fees, so the later `after.identityBalanceLamports` read should normally match; a lower value means another identity-signed operation ran concurrently and should be investigated.

Do not replace this flow with manual commands after a successful Phase 1. Do not use `solana confirm -v`, because it prints the configured RPC URL; use the executor's redacted RPC verification.

Balance-only drift below the approved ceilings does not require a second approval; a step whose recalculated amount becomes zero is skipped and reported in `skipped`. Stop and obtain a new read-only plan and explicit approval if the approval fingerprint changes, the action path or vote reserve changes before execution, funding or top-up exceeds its ceiling, a signer or account changes, a withdrawal request appears, simulation fails, the vote balance is below its reserve before bond funding, or the identity hard floor would be violated.

## Report and record

Report the executor's UTC and local completion time, vote reserve, before/after balances in lamports and SOL, skipped actions, warnings, vote top-up or withdrawal amount, bond change, funded stake account, and every transaction signature. Use its final JSON rather than making duplicate RPC calls. If a durable Markdown operation record exists for that validator, update it from this result while preserving `created` and setting `last_updated` in frontmatter.

## Failure handling

- If a vote top-up succeeds but a later step fails, the funds are where they belong (in the vote account); report the top-up signature and finalized balances and stop.
- If vote withdrawal succeeds but funding fails, stop. Report that the surplus is now in the identity and include the finalized balances and vote-withdrawal signature. Never retry or improvise without a fresh plan and approval.
- If the vote account ends below its reserve, report the shortfall and the risk of not being admitted at the next epoch start before anything else.
- If RPC submission returns an ambiguous error, resolve the transaction signature and finalized status before considering any retry.
- If balance drift would exceed the approved funding ceiling or consume the execution buffer and put the identity below the hard floor, stop and request a fresh approval; do not improvise another amount automatically.
- If the funding transaction left the identity below the `5 SOL` hard floor, report it as a safety failure immediately and do not perform another debit.
