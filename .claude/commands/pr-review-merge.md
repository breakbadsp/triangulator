---
description: Run the two-reviewer, comment-analyzer, and test-merge workflow on a pull request. Capped at two review rounds and two merge-gate runs.
argument-hint: <PR number>
---

Run the review workflow for pull request $ARGUMENTS. You are the orchestrator. Do not review or edit code yourself.

## Setup

1. Read the PR: `gh pr view $ARGUMENTS --json number,state,headRefName,headRefOid,url`. Stop if the PR is closed or merged.
2. Use the worktree that holds the PR branch (`git worktree list`). If none holds it, create one with `git worktree add`. Never use the primary checkout or `master`.
3. In that worktree, run `git fetch origin`. `git rev-parse HEAD` must equal `headRefOid`, and `git status --porcelain` must print nothing. Otherwise stop and report. Do not pull, reset, or push to fix it.
4. Start each role with the Agent tool, and pass the model and effort given below. If the session lists the role's agent type (`pr-adversarial-reviewer`, `pr-comment-analyzer`, or `pr-test-merger`), use it as `subagent_type`, so the `tools:` line in its file applies, and the reviewers and the test merger get no Edit or Write tool. Otherwise use `general-purpose`, and give the body of the role's definition file as the prompt, plus the inputs. The definition files are in the repository's `.claude/agents/`. Do not use copies in `~/.claude/agents/`, which can be out of date. Do not use `Explore` or `Plan`. They are read-only, but the reviewers post reviews and the test merger builds and merges.
5. After each reviewer run and each test-merger run, check the worktree again. HEAD must be unchanged, and `git status --porcelain` must print nothing. Otherwise stop and report. These roles must not edit files, and under `general-purpose` only their prompt stops them.

## Rounds

Run at most two rounds. Each round has the steps below.

1. Start both reviewers in parallel. Each starts fresh, and neither sees the other's output. Pass each the PR number, the worktree path, its ID prefix, its lens, the round number, and the PR head SHA.
   - Reviewer A: `pr-adversarial-reviewer`, model `opus`, effort `xhigh`. Lens: correctness, concurrency, memory safety, and failure paths. ID prefix `A`.
   - Reviewer B: `pr-adversarial-reviewer`, model `opus`, effort `xhigh`. Lens: requirements, tests, `AGENTS.md` rules, and docs accuracy. ID prefix `B`.
2. When both finish, confirm that both reviews reached GitHub. `gh api repos/{owner}/{repo}/pulls/<PR>/reviews` must list, among the reviews submitted after this round started, one whose body starts with `## Reviewer A, round <n>, head <SHA>` and one whose body starts with `## Reviewer B, round <n>, head <SHA>`. If either is missing, stop and report. Do not start the analyzer.
3. Start the comment analyzer: `pr-comment-analyzer`, model `opus`, effort `xhigh`. Pass the PR number, the worktree path, pass type `review`, and the round number. Do not pass it the reviewers' text. It reads the comments from GitHub.
4. Check that the `## Analyzer, round <n>` comment gives an outcome for every `blocker` and `major` ID in this round's reviews, and that every `FIXED` commit reached the PR. Run `git fetch origin` in the worktree, and read the head again with `gh pr view <PR> --json headRefOid`. For each `FIXED` SHA, `git merge-base --is-ancestor <sha> <headRefOid>` must exit 0. If a check fails, stop and report. Do not start the merge gate.
5. Compare the PR head SHA before and after the analyzer. After round 1, if it changed, start round 2. Otherwise go to the merge gate. After round 2, always go to the merge gate.

## Merge rule

Merge only when no `blocker` or `major` issue is open. Issues come from the review findings, from issues that the user raises in PR comments or reviews, and from the merge-gate results. The analyzer triages the user's issues in every pass, with IDs `U-<n>`.

- A review finding or user issue is open unless the analyzer marked it `FIXED` or `REBUTTED`. An `OUT-OF-SCOPE` `blocker` or `major` one stays open until the user accepts it. Ask the user, and record each acceptance in a PR comment that starts with `## User decision`.
- Treat an issue that the user calls `critical` as `blocker`.
- `minor` findings never block a merge.
- A failing merge-gate run is an open issue. A failing local check or CI check is `blocker`. Any other failing gate is `major`. A gate issue closes when a later run passes that gate. When the fix pass marks a gate issue `OUT-OF-SCOPE`, run 2 retries the gate. The user does not decide it.

## Merge gate

Run the merge gate at most twice.

1. Start a run only when no `blocker` or `major` review finding from any round, and no `blocker` or `major` user issue, is open, and the last analyzer pass changed no code or passed `make check` on each of its commits. Otherwise do not merge. Report the open issues.
2. Before you start it, run `git fetch origin` in the worktree. `git rev-parse HEAD` must equal the expected head SHA, which is the PR `headRefOid`, and `git status --porcelain` must print nothing. Otherwise stop and report.
3. Start `pr-test-merger`, model `haiku`, effort `low`. Pass the PR number, the worktree path, the expected head SHA, and the run number. It posts its results as a PR comment and merges only when every gate passes. When it finishes, read the result from a PR comment created after the run started that starts with `## Merge gate, run <n>, head <SHA>`. If there is none, stop and report.
4. If run 1 merged, finish. If it failed, start one fix pass: `pr-comment-analyzer`, model `opus`, effort `xhigh`. Pass the PR number, the worktree path, pass type `gate-fix`, and run number 1. It reads the gate results from the PR comment. Check its result as in round step 4. Then repeat steps 1 to 3 as run 2.
5. If run 2 fails, stop. Do not merge. Report the failing gates.

## Limits

- At most two review rounds. Never start a third round.
- At most two merge-gate runs, with one fix pass between them. Never start a third run.
- A run of `/pr-review-merge` never starts itself again, for this PR or any other. Do not run `/pr-review-merge` or the `pr-review-merge` skill from inside a run, and do not schedule it. The agents it starts never run it either. When a run stops, it reports to the user, and only the user starts a new run.
- Never merge while a `blocker` or `major` issue is open or a check fails.
- If a result is ambiguous, stop and report it to the user.

## Final report

Give the PR URL, the rounds run, the findings per severity per round, the analyzer outcomes, the merge-gate runs and their results, the commits pushed, and either the merge commit SHA or the open issues that stopped the merge. Mark each commit pushed after the last review round as not reviewed. Keep it under 15 lines.
