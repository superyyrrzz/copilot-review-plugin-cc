---
description: Monitor a PR for GitHub Copilot review feedback and iterate on it automatically
argument-hint: "[PR-number]"
allowed-tools: Bash(gh:*) Bash(git:*) Bash(dotnet:*) Read Glob Grep
---

# Copilot Review Loop

Non-blocking loop: schedule 5-min cron, fix Copilot comments each tick, repeat until Copilot says "generated no comments" (or "generated no new comments"). After each push, you MUST manually request a Copilot review via the API (see Copilot API Reference section below) — `review_on_push` rulesets do not work on personal/free GitHub plans.

Pass the PR number if provided: $ARGUMENTS

## Critical: Author login varies by API

**GraphQL uses `copilot-pull-request-reviewer` (no `[bot]`).** Getting this wrong silently misses all comments. See the API Reference section below for exact commands.

## Initial invocation

1. Detect PR number (conversation context, explicit mention, or `gh pr view --json number`)
2. Detect OWNER/REPO: `gh repo view --json owner,name`
3. Schedule cron: `CronCreate` with `*/5 * * * *`, `recurring: true`
4. Report to user and **return immediately** — never block/poll

## Each cron iteration

### CRITICAL: No blocking, no sleeping, no polling

Each iteration MUST be non-blocking. Check the state once, act or skip, and return immediately. **NEVER use `sleep` or poll in a loop waiting for Copilot to finish reviewing.** The cron fires every 5 minutes — if Copilot hasn't reviewed yet, simply skip the iteration and let the next cron tick handle it. This is the entire point of using a cron-based approach.

### 1. Always fetch unresolved Copilot threads first

Use GraphQL (see API Reference below). Filter by `copilot-pull-request-reviewer` (no `[bot]`).
If PR is MERGED/CLOSED, cancel cron and stop.

**Why threads-first**: Copilot's REST review API `commit_id` does NOT reliably update when Copilot leaves inline comments. If you gate on review SHA matching HEAD before checking threads, you will miss comments that Copilot left asynchronously. Always check threads regardless of review SHA.

### 2. If unresolved comments exist — fix them

For each unresolved comment:
- Read the code, assess validity
- Fix if valid; explain and dismiss if not
- Build and test (`dotnet build && dotnet test` or equivalent)
- Reply to comment, then resolve thread

After all comments addressed: commit and push. Then **manually request a Copilot review** using the API call in the reference section below.

### 3. If no unresolved comments — check Copilot's latest review

Fetch Copilot's latest review via REST (see API Reference below). Check two things:
- **`commit_id`** matches HEAD SHA
- **`body`** contains `"generated no comments"` or `"generated no new comments"`

If **both** match: Copilot reviewed the latest code and found nothing. **Cancel cron and report success.**

If commit_id does not match HEAD: Copilot hasn't reviewed the latest push yet. **Return immediately** — let the next cron tick check again. Do NOT sleep or poll.

If commit_id matches but body does NOT contain either phrase: Copilot reviewed but found issues:
- Re-fetch unresolved threads. If threads now exist, process them as in step 2.
- If **no inline threads exist**, Copilot's feedback is only in the top-level review body. Surface the body text to the user, **cancel the cron via `CronDelete`**, and hand control back to the user — do not keep looping expecting inline comments that may never appear.

## Stop conditions

- Copilot's latest review on HEAD contains "generated no comments" or "generated no new comments"
- PR merged/closed
- User cancels via `CronDelete`
- **Safety valve**: CronCreate auto-expires recurring jobs after 3 days. As an additional guard, stop after 20 cron iterations and surface a warning to the user if termination conditions were never met.

## Mandatory verification before declaring success

Before stopping the loop and reporting "clean pass," you MUST run this verification command and include the output in your response:

```bash
HEAD_SHA=$(gh pr view {PR} --repo {OWNER}/{REPO} --json headRefOid --jq '.headRefOid')
REVIEW_JSON=$(gh api repos/{OWNER}/{REPO}/pulls/{PR}/reviews --paginate \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | sort_by(.submitted_at) | last | {commit_id: .commit_id, body_snippet: (.body[:200])}')
REVIEW_COMMIT=$(echo "$REVIEW_JSON" | jq -r '.commit_id')
echo "HEAD:   $HEAD_SHA"
echo "REVIEW: $REVIEW_COMMIT"
echo "MATCH:  $([ "$HEAD_SHA" = "$REVIEW_COMMIT" ] && echo 'YES' || echo 'NO — loop must continue')"
echo "$REVIEW_JSON" | jq -r '.body_snippet'
```

**Interpret the output:**
- If MATCH is `NO` — Copilot has not reviewed HEAD yet. Do NOT stop. Wait for the next cron tick or re-request a review.
- If MATCH is `YES` but body does NOT contain "generated no comments" / "generated no new comments" — Copilot found issues. Do NOT stop.
- If MATCH is `YES` AND body contains the phrase — loop is done. Report success.

**This command is not optional.** Never declare the loop complete based on comment count alone or based on a review targeting a non-HEAD commit.

---

## Copilot API Reference

### Requesting a Copilot review

Copilot does NOT auto-review on push for personal/free GitHub plans. You must manually request a review after each push:

```bash
gh api repos/{OWNER}/{REPO}/pulls/{PR}/requested_reviewers \
  -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```

This must be called after every push to trigger a new Copilot review.

### Author login per API

| API | Login |
|-----|-------|
| REST (reviews) | `copilot-pull-request-reviewer[bot]` |
| GraphQL (reviewThreads) | `copilot-pull-request-reviewer` |

### Check if Copilot reviewed a specific commit

```bash
HEAD_SHA=$(gh pr view {PR} --json headRefOid --jq '.headRefOid')

gh api repos/{OWNER}/{REPO}/pulls/{PR}/reviews --paginate \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | sort_by(.submitted_at) | last | .commit_id'
```

**Note on `--paginate`**: `gh api --paginate` concatenates JSON array responses across pages into a single array before applying `--jq`, so `sort_by | last` correctly operates on all reviews. Do NOT use `--slurp` — it is not a valid `gh api` flag.

### Check if Copilot's latest review found no issues

```bash
gh api repos/{OWNER}/{REPO}/pulls/{PR}/reviews --paginate \
  --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | sort_by(.submitted_at) | last | {commit_id: .commit_id, body: .body}'
```

**Termination signal**: If `commit_id` matches HEAD AND `body` contains `"generated no comments"` or `"generated no new comments"`, Copilot is satisfied — the loop is done.

### Fetch unresolved threads (GraphQL)

```graphql
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR) {
      state
      reviewThreads(last: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId body createdAt author { login } }
          }
        }
      }
    }
  }
}
```

Filter: `isResolved == false` AND `author.login == "copilot-pull-request-reviewer"` (no `[bot]`).

### Reply to a comment

```bash
gh api repos/{OWNER}/{REPO}/pulls/{PR}/comments/{COMMENT_ID}/replies \
  -f body="<message>"
```

### Resolve a thread

```graphql
mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }
```
