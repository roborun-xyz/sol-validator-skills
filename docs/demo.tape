# VHS tape for docs/demo.gif: fresh install, onboarding, revenue check.
# Requires SOLANA_RPC_URL in the environment; see CONTRIBUTING.md. The vote account is public.
# The demo runs in a throwaway directory with its own operator configuration,
# so it never touches ~/.config/validator-ops.

Output docs/demo.gif

Set Shell bash
Set FontSize 14
Set Width 1700
Set Height 1000
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set PlaybackSpeed 1.5

Hide
Type "rm -rf /tmp/sol-skills-demo && mkdir -p /tmp/sol-skills-demo/.claude && cd /tmp/sol-skills-demo"
Enter
Type "export VALIDATOR_OPS_CONFIG=/tmp/sol-skills-demo/validator-ops.json"
Enter
Type "unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT"
Enter
Type `printf '{"permissions":{"allow":["Bash(bun:*)","Bash(cd:*)","Bash(realpath:*)","Bash(dirname:*)","Bash(ls:*)","Bash(cat:*)","Read","Glob","Grep"]}}' > .claude/settings.json`
Enter
Type "clear"
Enter
Show

Type "bunx --bun skills@1.7.0 add roborun-xyz/sol-validator-skills --skill onboarding validator-revenue --agent claude-code --yes"
Enter
Wait+Screen@120s /Done!/
Sleep 3s

Type "clear"
Enter
Type `claude "Use the onboarding skill to set up vote account R2D2vs3bJwpNF2ejaB6UW1JdCZ5VstuAmuwxDuUUWNj as profile demo (SOLANA_RPC_URL is already set in my environment), then use validator-revenue to show me the last 3 completed epochs."`
Enter
Wait+Screen@60s /trust this folder|auto mode on|bypass permissions on/
Sleep 2s
Down
Sleep 1s
Enter
Wait+Screen@600s /Net revenue|net revenue|Net SOL/
Sleep 12s
Type "/exit"
Enter
Sleep 2s
