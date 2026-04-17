---
description: Cancel a running Copilot review job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" cancel $ARGUMENTS`

Present the raw output to the user without extra prose.
