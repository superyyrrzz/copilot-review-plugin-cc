---
description: Show the full review output for a finished Copilot review job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" result $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete review text, including all findings
- File paths and line numbers exactly as reported
- Any error messages
