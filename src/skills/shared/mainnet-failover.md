---
created: 2026-09-20
last_updated: 2026-10-08
---

# Mainnet handoff readiness and verification

Use this reference for each direction of an authorized primary/backup handoff. Apply [upgrade preparation](upgrade-runbook.md) and resolve both instances from the operator's [host inventory](../inventory/references/hosts.md). Here, **outgoing** is the current voter and **incoming** is the verified unstaked receiver. The checks reduce avoidable interruption; they do not guarantee uninterrupted voting.

## Prepare while the outgoing instance still votes

Verify the same network and vote account, compatible client/tower formats, distinct unstaked identities, exact ledgers, supervisors and admin commands. Record both live identities and restart identities. Prevent either supervisor from restarting an instance staked while its peer votes. If the backup must change roles, first complete the target-role switch and verification in [backup role switching](backup-role-switch.md); restore its original role after the primary resumes verified voting.

Distinguish the production node identity from the vote account's authorized voter. Read the current on-chain voter authorization, including any scheduled epoch change, through the operator's configured mainnet RPC; verify key public keys without printing keypair contents. Confirm the incoming process has the required voter loaded, using the installed client's supported admin/config evidence. A warmup identity switch alone does not establish voter availability. For Agave, inspect the installed `authorized-voter` help and load a missing, already-authorized voter through the correct ledger/admin socket before demoting the outgoing instance. Do not change on-chain voting authorization as an incidental upgrade step. Verify this again after any restart.

Measure local health, replay progress and lag over repeated samples while the outgoing voter remains active. Query the **incoming instance's own RPC**, not a load balancer or a remote RPC provider, for local readiness. Explicitly request `getSlot` with `{"commitment":"processed"}` when measuring its processed slot; use the same commitment for cluster comparisons. Check roots and logs for ongoing progress. Investigate stalled or increasing lag rather than relying on elapsed startup time, one health response or a fixed slot threshold.

Before demotion, prepare and verify a release-matched, read-only way to obtain the final last-voted slot from the outgoing saved tower (or local vote evidence demonstrably tied to that exact tower). Record the tool/version and interpretation in the instance runbook; do not invent a portable tower-decoding command. Establish this method using a preflight sample, then repeat it on the final tower after demotion. An RPC node's `getSlot` is not its last vote, and the on-chain vote account's `lastVote` alone does not prove the newest locally saved vote. If the required evidence cannot be obtained, leave the outgoing instance voting and resolve the gap before handoff.

## Handoff

1. Recheck incoming readiness and voter availability immediately before demotion. Demote only the outgoing instance to its verified unstaked identity with the installed client's supported command. Verify the result and persistent restart state before touching the incoming identity. An ambiguous result requires diagnosis, not another identity switch.
2. Obtain the staked identity's fresh tower from the just-demoted instance after the client's tower write has completed. Record identity, format, final last-voted slot and checksum. Copy through a unique temporary file, verify SHA-256 at source, transit and destination, and install with the receiver's required owner/mode. Do not overwrite it with a preflight sample or an older backup copy.
3. Recheck incoming local processed slot against the **final transferred tower's** last-voted slot: it must have reached at least that slot. Verify continuing health/replay progress. This comparison is a lag check, not proof of compatible forks, valid voting authorization or complete tower recovery; retain the client's tower/fork checks. A failed or unavailable check blocks promotion. Use the prepared recovery plan if the handoff cannot complete; never omit tower enforcement to get past a failure.
4. Promote the incoming instance with the verified binary/config/ledger, production identity and `set-identity --require-tower` where that supported interface was verified. Do not interrupt an in-progress identity switch or add a force/bypass option automatically. Confirm its actual local identity and that the outgoing instance remains unstaked, including restart behavior.
5. Observe the selected vote account through the configured mainnet RPC with explicit commitment: advancing votes and roots, expected node identity and current/non-delinquent status across repeated samples. Diagnose missing votes using identity, voter availability, replay/tower state and logs; delinquency alone does not identify which check failed. Apply the operator's observation window and investigate promptly if voting does not resume.

After success, apply the deployment's intended restart policy explicitly. Some primaries intentionally start unstaked and require a supervised promotion; others persist the staked identity. Verify that policy and voter loading rather than silently changing it. Keep the other instance unstaked.

## Failure and records

Before demotion, keep the current voter running while preparation or catchup is incomplete. After demotion or an ambiguous promotion, establish both live identities and whether either has cast newer votes before recovery. Recover with the latest applicable tower; never promote both sides, restore a stale tower, or blindly retry a timed-out switch. If the backup is voting and the primary upgrade fails, repair or roll back the primary while it stays unstaked, then repeat the complete handoff checks.

Record source/destination roles, evidence provenance, tower checksum/last vote, local replay samples with commitment, post-promotion vote progress, and UTC/local observation times in the operator's private record. Report unobserved periods and unresolved checks rather than claiming zero delinquency from a single sample.

## Primary references

- [getSlot](https://solana.com/docs/rpc/http/getslot) returns the highest slot at the requested commitment; it does not decode a tower.
- [getHealth](https://solana.com/docs/rpc/http/gethealth) describes health relative to the configured distance from cluster tip.
- [getVoteAccounts](https://solana.com/docs/rpc/http/getvoteaccounts) exposes chain-observed vote progress for post-handoff monitoring.
- Agave's [identity command](https://github.com/anza-xyz/agave/blob/master/validator/src/commands/set_identity/mod.rs), [authorized-voter command](https://github.com/anza-xyz/agave/blob/master/validator/src/commands/authorized_voter/mod.rs) and [tower implementation](https://github.com/anza-xyz/agave/blob/master/core/src/consensus.rs) provide source references. Resolve these against the installed release; current upstream source is not evidence of a deployed binary's exact interface.
