---
created: 2026-09-15
last_updated: 2026-09-25
---

# Local fleet onboarding for SFDP and host checks

Store operator-specific host data outside the repository, by default at `~/.config/validator-ops/fleet.json`. Set `VALIDATOR_OPS_FLEET` or pass SFDP's `--fleet PATH` to choose another file. This file is separate from chain-query profiles: an SFDP group requires both mainnet and testnet identities, while a chain profile requires only a mainnet validator.

Ask for the group name and the paired **identity** public keys. Reuse verified public information already provided in the conversation or local profiles. Do not substitute vote accounts for identities. A partial SFDP identity-pair match is not sufficient to identify a participant.

For participation-only checks, create a versioned file with `hosts: []`. For live checks, use [inventory](inventory.md) to verify SSH aliases, local RPC ports, client families, expected identities, optional vote accounts, and descriptive roles, then map those facts into this schema. Ask only for missing fields; there are no built-in host aliases or operator identities.

```json
{
  "version": 1,
  "groups": {
    "my-validator": {
      "mainnetBetaPubkey": "REPLACE_WITH_MAINNET_IDENTITY",
      "testnetPubkey": "REPLACE_WITH_TESTNET_IDENTITY"
    }
  },
  "hosts": [
    {
      "group": "my-validator",
      "cluster": "testnet",
      "host": "my-testnet-ssh-alias",
      "rpc_port": 8899,
      "client": "firedancer",
      "expected_identity": "REPLACE_WITH_TESTNET_IDENTITY",
      "vote_account": "",
      "role": "testnet primary"
    }
  ]
}
```

The placeholder keys intentionally fail validation until replaced. Allowed clusters are `mainnet-beta` and `testnet`; clients are `agave`, `jito-agave`, and `firedancer`. Use preconfigured SSH aliases or `user@hostname`, without options, whitespace, or shell expressions. Put connection options in the operator's SSH config. No passwords, RPC URLs, or private key material belong in this file.

Create the parent directory with mode `0700` and the configuration with mode `0600`. Validate the prepared file locally before making network calls:

```bash
.venv/bin/python src/skills/sfdp-check/scripts/check_sfdp.py --fleet /path/to/fleet.json --validate-config
.venv/bin/python src/skills/sfdp-check/scripts/check_sfdp.py --fleet /path/to/fleet.json --api-only
```

Resume the original SFDP check after configuration. `--api-only` makes no SSH calls and cannot establish live health, installed version, or identity. A live check compares configured identities with the host RPC response; it never silently updates the file.

Each configured host identity must equal its SFDP group identity for that cluster. An unstaked backup with a different identity does not belong in this schema; record it in `hosts.md` instead.

This schema does not establish failover readiness, signer availability, or an upgrade layout. Collect and verify those separately before a mutation. Upgrade skills require a reviewed host inventory and live preflight.
