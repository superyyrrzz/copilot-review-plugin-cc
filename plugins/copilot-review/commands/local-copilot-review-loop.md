---
description: Run the local Copilot CLI to review code, fix findings, and re-review until clean
argument-hint: "[--base <ref>]"
allowed-tools: Bash(node:*) Bash(which:*) Bash(where:*) Bash(git:*) Bash(dotnet:*) Read Glob Grep
---

# Local Copilot CLI Review Loop

Iterative loop: run ACP-based review, fix findings, re-run, repeat until clean.

This is for the **npm-installed standalone `copilot` CLI** (`npm install -g @github/copilot`) — **NOT** `gh copilot` (the GitHub CLI extension, which has no review capability).

Additional context from user: $ARGUMENTS

## Running the CLI

Use the ACP companion script for structured, session-based reviews. Run in **background mode** so progress is visible via `/copilot-review:status`:

```bash
# Launch a background review (returns immediately with job ID)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" review --background --base <base_ref>
```

After launching, **poll for progress and wait for completion**:

```bash
# Check progress (shows log tail with live updates)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" status <job-id>

# Wait for the review to finish (blocks until done, up to 4 min)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" status <job-id> --wait

# Retrieve the full review output
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" result <job-id>
```

**Options for `review`:**
- `--base <ref>` — Git base ref for diff (e.g., `main`, `origin/main`). Omit for working-tree changes.
- `--background` — Run review in background, return job ID immediately.
- `--cwd <path>` — Working directory (default: current directory)
- `--timeout <ms>` — Max wall-clock timeout in ms (default: 1800000 = 30 min)
- `--idle-timeout <ms>` — Cancel if no activity for this long, in ms (default: 120000 = 2 min)
- Positional args after flags are treated as additional focus text

**Examples:**
```bash
# Background review against main branch
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" review --background --base main

# Foreground review (blocks until complete — use only for quick diffs)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-acp-companion.mjs" review --base main
```

- The companion script manages the ACP lifecycle internally (connect, session, prompt, cleanup)
- Set `COPILOT_ACP_ALLOW_ALL_TOOLS=1` to pass `--allow-all-tools` to Copilot CLI, broadening tool-execution permissions. Only enable in trusted, controlled environments.
- Uses activity-based idle timeout (default 2 min) — as long as Copilot is actively working (thinking, reading files, running tools), the session continues. A 30-minute wall-clock safety valve prevents runaway sessions.
- Findings are reported as `[file:line] severity (high/medium/low): description`

## Workflow

**IMPORTANT: This is a MANDATORY loop. You MUST keep iterating until a stop condition is met. Do NOT stop after a single iteration just because you fixed or dismissed some findings.**

1. **Detect scope**: Determine `--base` ref. For PRs use the PR base branch. For local work use `main` or `origin/main`. Note: `--base` performs a commit-to-commit diff (`base...HEAD`), so staged/unstaged working-tree changes are NOT included — commit first, or omit `--base` to diff against HEAD including working-tree changes.
2. **Launch background review**: Run `review --background --base <ref>`. Parse the JSON output to get the `jobId`.
3. **Wait for completion**: Run `status <jobId> --wait` to block until the review finishes. You can also run `status <jobId>` periodically to show progress to the user.
4. **Retrieve results**: Run `result <jobId>` to get the full review output.
5. **Process ALL findings from this iteration**:
   - Read the referenced code at the cited line numbers to verify each finding
   - Fix findings that are valid
   - Dismiss findings that are invalid (note why briefly)
   - Track counts of fixed vs dismissed, and maintain a list of dismissed findings (file, line range, issue summary) for loop detection
6. **If code was changed**: build and test. If build/test fails, stop and surface the error.
7. **If code was changed**: commit the fixes (do NOT push unless user asked)
8. **Re-run the companion script** — launch a NEW background review (`review --background --base <ref>`), wait with `status <jobId> --wait`, retrieve with `result <jobId>`
9. **Repeat from step 5** until a stop condition is met

### Stop conditions

- CLI output contains no `[file:line]` findings (only praise, "looks good", "No issues found.", or "No changes found to review.")
- ALL findings in the current iteration were already seen AND dismissed in a PREVIOUS iteration of THIS loop (loop detection). "Previous conversation" findings do NOT count — only findings from this invocation.
- 5 iterations reached (safety valve — surface remaining findings to user)
- Build/test fails after a fix (stop, surface error, let user decide)
- CLI times out (report it, suggest retrying)

### What counts as "same finding" for loop detection

Two findings are the same if they reference the same file, similar line range (plus or minus 10 lines), and describe the same core issue. Cosmetic wording differences don't matter. If the finding is about code you just changed, it's NOT a repeat — re-assess it.

## Output format

After the loop ends, report:

```
Local Copilot CLI review complete.
- Iterations: N
- Findings fixed: X
- Findings dismissed (invalid): Y
- Remaining: Z (if any)
```

---

## Local Copilot CLI Reference

### Installation

The Copilot CLI is installed globally via npm. Locate it with:

```bash
where copilot    # Windows
which copilot    # macOS / Linux
```

### Invocation

```bash
copilot -p "<prompt>"
```

The `-p` flag passes a prompt directly. The CLI:
1. Auto-detects the git repo from `git remote -v`
2. May use multiple models internally
3. Outputs findings as plain text to stdout
4. Exit code 0 on success regardless of findings

### Known issues

#### Repo name resolution
The CLI reads `git remote -v` to detect the repo. If the repo was recently renamed, the CLI may initially try the old name. It usually self-corrects via GitHub's redirect, but verify in the output if you see 404 errors.

#### Timeout
Execution time varies widely: simple reviews ~1-2 minutes, cross-referencing prompts can take 5+ minutes. Set a 600s (10 min) timeout. If it exceeds that, kill and retry with a narrower prompt.

#### Output format
The CLI output is unstructured text — not JSON. Parse findings by looking for patterns like:
- File paths with line numbers
- Suggestions phrased as "consider", "should", "could"
- Severity indicators (if any)

The exact format varies by model and prompt.
