---
created: 2026-09-25
last_updated: 2026-09-30
---

# Public skill source

This repository owns reusable validator skills. Operator inventory, profiles, credentials, signer paths and operation records belong outside it. Configuration does not authorize transactions, restarts or identity changes.

Author instructions and helpers in `src/skills`. Each skill's `instructions.md` becomes its published `SKILL.md`; supporting references are copied with rewritten local links. `skills/<name>` is the generated, independently installable Agent Skills distribution. Run `bun run skills:build` after source changes; do not hand-edit generated files. Shared runtime dependencies and their pinned lock are maintained in `runtime/`.

Run `bun run validate` for offline regression tests, TypeScript, generated-file consistency, manifest/reference checks and the release allowlist. Run `bun run test:install` when packaging or installation changes; it uses the pinned skills CLI in a temporary project and does not install user/global skills. Network package installation precedes offline checks. Use Bun/TypeScript and the repository's `.venv/bin/python` for Python work.

Use synthetic fixtures, never production mutations, as tests. Do not read signer contents or commit RPC credentials. Respect operator-selected configuration paths and user-level defaults independently of the session directory. Keep approval requirements tied to actual mutations and preserve established live-role/tower checks.

Maintain Markdown `created` and `last_updated` dates, including string-valued skill metadata dates. Use Conventional Commits and split unrelated scopes. Keep `release-files.json` explicit: review new source files and generated outputs before adding them. Publishing commits, tags or release artifacts is a separate action from local preparation.

Apply DRY to authored sources: keep common operational policy and identical runtime behavior in `src/skills/shared`, and reuse helpers or linked references. Keep workflow-specific approval, network, missing-data and tower semantics explicit. Generated copies in `skills/` are intentional for independent installation; consolidate their sources and regenerate them.
