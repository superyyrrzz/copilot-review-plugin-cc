# copilot-review-plugin-cc

Claude Code plugin for automated code review loops using GitHub Copilot.

Unlike review loop plugins that rely on OpenAI Codex, this plugin uses **GitHub Copilot** as the review backend — both via the GitHub PR reviewer and the local Copilot CLI.

## Skills

### `copilot-review:copilot-review-loop`

**PR-based cron loop.** Monitors a GitHub PR for Copilot review comments, fixes them, pushes, re-requests review, and repeats until Copilot reports "generated no comments."

- Non-blocking — uses a 5-minute cron schedule
- Automatically requests Copilot reviews after each push (required for non-Enterprise GitHub plans)
- Fetches unresolved threads via GraphQL, resolves them after fixing
- Stops when Copilot is satisfied, PR is merged/closed, or safety valve triggers

### `copilot-review:local-copilot-review-loop`

**Local CLI iterative loop.** Runs the Copilot CLI locally via the Agent Client Protocol (ACP) to review code changes, fix findings, and re-run until clean — no PR required.

- Drives Copilot CLI over ACP using the bundled `copilot-acp-companion.mjs` script
- Activity-based idle timeout (default 2 min) lets long but active reviews continue
- Wall-clock safety valve (default 30 min) prevents runaway sessions
- Structured finding format: `[file:line] severity (high/medium/low): description`
- Stops when no findings remain, loop detection triggers, or 5 iterations reached

## Installation

```bash
# Add the marketplace
/plugin marketplace add superyyrrzz/copilot-review-plugin-cc

# Install the plugin
/plugin install copilot-review@copilot-review
```

## Prerequisites

- [GitHub Copilot CLI](https://www.npmjs.com/package/@github/copilot) (`npm install -g @github/copilot`) — required for local review loop
- [GitHub CLI](https://cli.github.com/) (`gh`) — required for PR-based review loop
- Node.js 18+

## Usage

### PR-based review loop

Open a PR and tell Claude Code:

> "Run copilot review loop on this PR"

Or invoke directly:

```
/copilot-review:copilot-review-loop
```

### Local review loop

Make some changes and tell Claude Code:

> "Run local copilot review"

Or invoke directly:

```
/copilot-review:local-copilot-review-loop
```

## Development

Test the plugin locally without installing:

```bash
claude --plugin-dir ./plugins/copilot-review
```

## License

MIT
