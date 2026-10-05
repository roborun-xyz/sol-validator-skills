---
name: doublezero-status
description: Quickly check DoubleZero Edge client status on Solana validator hosts. Use when asked to check DoubleZero, DZ, doublezerod, DoubleZero Edge, BGP tunnel status, edge-solana-shreds multicast, DoubleZero routes, DoubleZero latency, or recent DoubleZero logs on configured validator hosts.
license: MIT
compatibility: Requires Bash and SSH. Targets need Linux, systemd, iproute2, GNU timeout and DoubleZero.
metadata:
  created: "2026-06-12"
  last_updated: "2026-10-03"
---

# DoubleZero Status

Read [installed bundle and configuration](../shared/runtime.md) before running commands. Resolve paths from this loaded SKILL.md, not the session working directory.

## Overview

Use this skill to perform a fast, read-only DoubleZero health check over SSH and summarize whether the host is connected to the DoubleZero mainnet-beta network and whether the DoubleZero Edge Solana shreds multicast signal is present.

Prefer the bundled helper for normal checks:

```bash
src/skills/doublezero-status/scripts/check-doublezero-status.sh <SSH_ALIAS>
```

Use the host aliases the user names. For a vague request like "check dz status", read the operator's host inventory first and resolve the active mainnet primaries from it. Ask for target aliases, before connecting, only when the inventory is missing or does not identify them. `fleet.json` covers SFDP production checks only and may omit backups; use it only when those explicitly selected instances are the intended targets. There are no built-in fleet defaults.

## Workflow

1. Resolve aliases and roles from operator-owned inventory (read `VALIDATOR_OPS_HOST_INVENTORY` or `~/.config/validator-ops/hosts.md`; see `../inventory/references/hosts.md`). Do not treat a bundled example or another operator's inventory as a target selection.
2. Run the helper from the resolved bundle root with the target SSH aliases.
3. Report:
   - UTC and local check time. The helper's local time defaults to UTC; override with `LOCAL_TIME_ZONE` when needed.
   - `doublezerod.service` active/substate, PID, restart count, and start timestamp.
   - `doublezero status` tunnel rows, especially `BGP Session Up`.
   - Edge signal: `P:edge-solana-shreds` present or missing.
   - `doublezero0` and `doublezero1` addresses.
   - Route counts for each DoubleZero interface.
   - Closest latency rows from `doublezero latency`.
   - Recent warnings/errors from `journalctl -u doublezerod`.
   - Client upgrade warning if the CLI prints one.
4. Keep the final answer concise. Do not paste full route tables or full latency tables unless the user asks.

## Helper

The helper runs read-only commands:

```bash
src/skills/doublezero-status/scripts/check-doublezero-status.sh <host> [host...]
```

Exit `1` reports at least one SSH collection failure; it is not a parsed health verdict. Interpret the collected evidence below. Invalid aliases are rejected before connecting; SSH uses batch mode and bounded connection/keepalive waits.

The helper targets Linux hosts with GNU `timeout`; DoubleZero CLI calls have a 30-second bound. Timeout output means incomplete evidence, not a healthy service.

It uses `ssh`, `systemctl show`, `ip -br addr`, `ip route`, `doublezero status`, `doublezero latency`, `doublezero routes`, and `journalctl`. It does not restart services, modify routes, or change DoubleZero configuration.

## Interpretation

- Healthy DoubleZero baseline: `doublezerod` is active/running, `NRestarts=0` or explained, both `doublezero0` and `doublezero1` exist, tunnel status shows `BGP Session Up`, route counts are nonzero, and recent logs do not show repeated errors.
- Healthy Edge signal: `doublezero status` contains a `Multicast` tunnel row whose multicast group includes `P:edge-solana-shreds`. Report this separately from generic DoubleZero tunnel health.
- `doublezero1` is typically the multicast/shreds interface, but do not rely on interface name alone. Treat `P:edge-solana-shreds` as the strongest local Edge signal.
- If `edge_signal=missing` but DoubleZero BGP is healthy, say the host is on DoubleZero but Edge Solana shreds multicast was not detected.
- `doublezero latency` may print a client upgrade warning. Treat this as maintenance advice, not service failure, unless the user asked for upgrade readiness.
- `doublezero routes` can contain many rows. Count states or sample the first rows; avoid dumping all routes.
- Kernel interface state `UNKNOWN` is normal for these tunnel-style interfaces when BGP sessions and routes are present.

## Helper recovery and manual diagnostics

If the helper is missing, restore the installed bundle using the runtime reference. For individual diagnostic commands, use `src/skills/doublezero-status/scripts/check-doublezero-status.sh` as the command reference. Preserve its alias validation, batch-mode SSH, bounded connection/CLI waits, and UTC/local timestamp output when running commands individually.
