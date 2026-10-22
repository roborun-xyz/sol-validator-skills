---
created: 2026-09-20
last_updated: 2026-10-22
---

# Mainnet handoff readiness and verification

Use this reference for each direction of an authorized primary/backup handoff. Apply [upgrade preparation](upgrade-runbook.md) and resolve both instances from the operator's [host inventory](../inventory/references/hosts.md). Here, **outgoing** is the current voter and **incoming** is the verified unstaked receiver. The checks reduce avoidable interruption; they do not guarantee uninterrupted voting.

## Alpenglow consensus state

Mainnet runs Alpenglow from epoch 1064 (slot 459,653,000). The equivocation-protection artifact is the staked identity's **vote history**, `vote_history-<STAKED_IDENTITY>.bin`, not the Tower BFT tower. The tower file (`tower-1_9-<identity>.bin`) is no longer updated after the Alpenglow transition, so a tower that loads is stale and proves nothing; never use `--require-tower`, a tower checksum or a tower last-voted slot as a handoff gate. Only Alpenglow-capable releases can participate: Agave/Jito-Agave/Harmonic Salsa 4.3.2 or later, and full Firedancer at or above the SFDP-published `firedancer_full_min_version` for the target epoch. Refuse any incoming, rollback or alternate launcher binary below that floor.

Agave's vote-history restore checks the file's signature and node identity, not its freshness. A stale `vote_history-<staked>.bin` left on the incoming node will be accepted and can cause equivocation. Freshness is therefore the operator's responsibility and is enforced by the sequence below.

| Client | Vote history location | Outgoing (demote) | Incoming (promote) |
|---|---|---|---|
| Agave/Jito-Agave 4.3.x | Ledger directory, `vote_history-<id>.bin` | `agave-validator -l <ledger> set-identity <unstaked>`; the staked identity's file stays at `vote_history-<staked>.bin` | Place the fresh file in the ledger directory as `vote_history-<staked>.bin`, then plain `set-identity <staked>` (vote history is required by default) |
| Full Firedancer (`firedancer` binary, verified at v26.10.3) | `[paths.vote_history]` | `firedancer set-identity <unstaked>` saves the staked identity's file as `vote_history-<staked>.bin.bak` | Place the file **outside** `[paths.vote_history]` and run `set-identity <staked> --vote-history-file <path>`; there is no `--require-tower` |

A Firedancer `set-identity` **without** `--vote-history-file` treats the identity as never having voted; never promote Firedancer that way. If Firedancer stopped without switching away, its latest file is `vote_history-<staked>.bin` and the `.bak` is not the latest. Firedancer forks (for example FireBAM) and Frankendancer (`fdctl`, which keeps Agave-style `--require-tower`/`--do-not-require-vote-history` flags) must be verified separately: if the installed binary's `set-identity --help` and release source do not match one row above, stop and require an operator-confirmed procedure for that step rather than adapting another client's commands.

## Prepare while the outgoing instance still votes

Verify the same network and vote account, Alpenglow-capable releases on both sides, compatible vote-history handling, distinct unstaked identities, exact ledgers/vote-history directories, supervisors and admin commands. Record both live identities and restart identities. Prevent either supervisor from restarting an instance staked while its peer votes. If the backup must change roles, first complete the target-role switch and verification in [backup role switching](backup-role-switch.md); restore its original role after the primary resumes verified voting.

Distinguish the production node identity from the vote account's authorized voter. Read the current on-chain voter authorization, including any scheduled epoch change, through the operator's configured mainnet RPC; verify key public keys without printing keypair contents. Confirm the incoming process has the required voter loaded, using the installed client's supported admin/config evidence. A warmup identity switch alone does not establish voter availability. For Agave, inspect the installed `authorized-voter` help and load a missing, already-authorized voter through the correct ledger/admin socket before demoting the outgoing instance. Do not change on-chain voting authorization as an incidental upgrade step. Verify this again after any restart.

Check Alpenglow admission before any handoff; a failure blocks the handoff and leaves the outgoing instance voting:

- **BLS registration.** There is no separate BLS key file; the BLS keypair is derived from the loaded authorized-voter key. `solana-keygen bls_pubkey <authorized-voter keypair path>` (prints a public key only) must equal the BLS public key registered in the vote account. A missing or mismatched registration is an operator decision, not an incidental fix.
- **Vote Account Threshold.** The vote account must hold at least its rent-exempt minimum plus 0.8 SOL at each epoch start, or the validator is not admitted for the next epoch. Read the balance and rent-exempt minimum through the configured RPC; if the margin is thin or an epoch boundary falls inside the maintenance window, report it before proceeding.

Inspect the incoming node's vote-history location for `vote_history-<staked>.bin` (and, for Firedancer, any `.bin.bak`/`.bin.swp` for the staked identity). Any such file present before the outgoing demotion is stale: record its checksum and modification time, then move it aside to a uniquely named quarantine path outside the active directory without deleting it. Re-list the directory to confirm no staked-identity vote history remains before demotion.

Measure local health, replay progress and lag over repeated samples while the outgoing voter remains active. Query the **incoming instance's own RPC**, not a load balancer or a remote RPC provider, for local readiness. Request `getSlot` with explicit commitment (`processed` for replay lag; `finalized` for finalization progress) and use the same commitment for cluster comparisons. Investigate stalled or increasing lag rather than relying on elapsed startup time, one health response or a fixed slot threshold. Alpenglow slots are about 200–216 ms; convert slot gaps to time with that measured rate.

Before demotion, prepare a release-matched, read-only way to obtain the outgoing instance's final voted slot from its vote history or from local log evidence demonstrably tied to that file. Record the tool/version and interpretation; do not invent a portable vote-history decoder. Under Alpenglow the vote account's `lastVote` equals its `rootSlot`, so `getVoteAccounts` does not reveal the newest locally cast vote. If no reliable final-vote evidence exists, use the stricter gate in step 3 below; if neither is available, leave the outgoing instance voting.

## Handoff

1. Recheck incoming readiness, voter availability, BLS/VAT admission and the absence of stale staked vote history immediately before demotion. Demote only the outgoing instance to its verified unstaked identity with the installed client's supported command. Verify the result and persistent restart state before touching the incoming identity. An ambiguous result requires diagnosis, not another identity switch.
2. After the demotion has completed and the outgoing node has stopped voting as the staked identity, take the staked identity's vote history from the just-demoted instance (the file named in the table above). Record identity, final voted slot where available, size and SHA-256. Copy through a unique temporary file, verify SHA-256 at source, transit and destination, and install at the incoming client's required location with its runtime owner/mode. Confirm the file belongs to the staked identity (filename and the client's own identity check). Never substitute a preflight sample, a quarantined file, an older backup copy or a tower file.
3. Gate promotion on all of: the incoming node has caught up (local processed slot at or beyond the cluster's, with continuing replay progress); its local **finalized** slot and the cluster finalized slot have passed the outgoing instance's final voted slot (if that slot is unknown, the time of demotion plus at least one finalization-latency margin observed on the cluster); and the vote-history checksum still matches. This is a lag and safety gate, not proof of voting authorization. A failed or unavailable check blocks promotion.
4. Promote the incoming instance with the verified binary/config/ledger and production identity. For Agave use plain `set-identity <staked>`, which requires the vote history. For Firedancer pass `--vote-history-file`. Never add `--do-not-require-vote-history`, omit Firedancer's `--vote-history-file`, add `--force`, or use `--require-tower` as a substitute. Do not interrupt an in-progress identity switch. Confirm the actual local identity and that the outgoing instance remains unstaked, including restart behavior.
5. Observe the selected vote account through the configured mainnet RPC with explicit commitment: expected node identity, advancing `rootSlot`/finalized progress and growing current-epoch credits (ignore the `u64::MAX` sentinel entry in `epochCredits`), and current/non-delinquent status across repeated samples. Do not rely on `lastVote` minus `rootSlot`, which is zero under Alpenglow. Diagnose missing votes using identity, voter availability, BLS/VAT admission, vote history and logs; delinquency alone does not identify which check failed. Apply the operator's observation window and investigate promptly if voting does not resume.

After success, apply the deployment's intended restart policy explicitly. Some primaries intentionally start unstaked and require a supervised promotion; others persist the staked identity. Verify that policy and voter loading rather than silently changing it. Keep the other instance unstaked.

## Dead or unreachable outgoing primary

Anza documents one exception, for a primary that is unreachable or whose disk is corrupted so no vote history can be retrieved. Use it only with explicit operator approval for that exact situation: confirm the primary is shut down (power it off if necessary) so it cannot vote, confirm the incoming node has fully caught up and finalized past the primary's last vote, then run Agave `set-identity --do-not-require-vote-history`. Never use this bypass because a copy failed on a reachable primary, a check timed out, or a gate is inconvenient.

## Failure and records

Before demotion, keep the current voter running while preparation or catchup is incomplete. After demotion or an ambiguous promotion, establish both live identities and whether either has cast newer votes before recovery. Recover with the latest vote history from the instance that last voted; never promote both sides, restore a stale or quarantined vote history, or blindly retry a timed-out switch. If the backup is voting and the primary upgrade fails, repair or roll back the primary while it stays unstaked, then repeat the complete handoff checks.

Record source/destination roles, evidence provenance, vote-history path/checksum/final voted slot, quarantined files, BLS and VAT checks, local replay and finalized samples with commitment, post-promotion vote progress, and UTC/local observation times in the operator's private record. Report unobserved periods and unresolved checks rather than claiming zero delinquency from a single sample.

## Primary references

- Anza's [validator failover guide](https://docs.anza.xyz/operations/guides/validator-failover) ("Changes for Alpenglow") transfers `vote_history-<IDENTITY>.bin` instead of a tower, requires vote history by default and limits `--do-not-require-vote-history` to an unreachable primary.
- Agave v4.3.2 [identity command](https://github.com/anza-xyz/agave/blob/v4.3.2/validator/src/commands/set_identity/mod.rs), [authorized-voter command](https://github.com/anza-xyz/agave/blob/v4.3.2/validator/src/commands/authorized_voter/mod.rs) and [vote history](https://github.com/anza-xyz/agave/blob/v4.3.2/votor/src/vote_history.rs) (`VoteHistory::restore` verifies signature and identity, not freshness).
- Firedancer v26.10.3 [set-identity](https://github.com/firedancer-io/firedancer/blob/v26.10.3/src/app/firedancer/commands/set_identity.c) and [votor vote history](https://github.com/firedancer-io/firedancer/blob/v26.10.3/src/discof/votor/fd_votor_tile.c); the [CLI book](https://docs.firedancer.io/api/cli.html) describes the `.bak` manual failover. Book pages at release tags may still describe the old tower interface; the installed binary's help is authoritative.
- [getSlot](https://solana.com/docs/rpc/http/getslot), [getHealth](https://solana.com/docs/rpc/http/gethealth) and [getVoteAccounts](https://solana.com/docs/rpc/http/getvoteaccounts) for local and chain-observed progress.

Resolve source references against the installed release; current upstream source is not evidence of a deployed binary's exact interface.
