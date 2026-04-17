---
description: Show active and recent Copilot review jobs
argument-hint: "[job-id] [--wait] [--timeout-ms <ms>] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" status $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
