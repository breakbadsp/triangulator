# LoomFlow

- This is the tool-neutral review workflow. Use `git` and `gh`; take checks, standards, and sensitive paths from the repository's `AGENTS.md`.
- Claude Code adapter: [command](../.claude/commands/loomflow.md) and [role prompts](../.claude/agents/).
- Roles: orchestrator selects and coordinates; reviewers stay read-only; analyzer fixes or rebuts; test-and-merge runs the gate once.
- Only the user starts a run. Roles never start LoomFlow. Maximum: two review rounds and one merge gate.

## Select the review

- Use `scan` only when no sensitive path changes and either all files are documentation or at most 30 lines change in at most three files.
- Sensitive paths include CI, build files, dependency manifests/locks, auth/secrets, storage/wire formats, and the repository's list. Documentation on these paths still needs `full`.
- Use `full` for every other change or any doubt. A user-requested `full` cannot be downgraded.
- `scan` uses one quick reviewer. `full` uses one large capable reviewer and one small quick reviewer, in parallel on the same head SHA.
- Prefer different model families, including one different from the orchestrator. If unavailable, keep the large-and-small pair in the available family. Never use two large reviewers.
- Check the remaining token budget before each role. Use low effort for simple work or small/unknown budgets; medium otherwise. Use high only for a concrete complex risk with enough budget for fixes and the gate.
- Critical paths require Opus 5.5 at high effort, or GPT 6.1 Sol at high when available and limits permit. Never select Astra 6; use GPT 6.1 Sol at high instead. This overrides the normal effort rule.

## Review method

- Report only blocker and major findings. Check callers, readers, failure paths, boundaries, and regression coverage.
- Try to disprove each finding before posting it. Drop it if a guard, caller, or test prevents the failure.
- The deep reviewer checks PR claims and the fact that makes the change safe. Measurements count only when error-free runs execute the changed code.
- Reviewers run no builds or tests. They leave HEAD and worktree unchanged.
- Each reviewer posts a PR comment. A missing required review stops the run.

## Rounds

- For `scan`, no blocker/major means proceed to checks and gate.
- A scan finding escalates to full round 1 with both reviewers on the whole diff. Keep the scan findings open for the analyzer even if later reviewers find none.
- For `full`, collect both reviews on the same head SHA.
- With no blocker/major, apply check reuse, then proceed to the gate. Stop at the first failed check.
- With findings, start one analyzer on their deduplicated union. Check quick-reviewer findings with extra care.
- The analyzer reads CI at start and before pushing. Each failed check is a blocker: read its log and fix its cause. Never rerun CI.
- Before fixing behavior, add a regression test and confirm failure without the fix when a cheap local target exists. Run only that test for this step.
- If round 1 changes HEAD, run round 2 on the fixes and new commits only. Check their callers too. Pass the original and new SHAs.
- After round 2, any open blocker/major or user-raised critical issue stops the run for manual handling.
- No third round, second gate, or automatic restart. Report commits pushed after the last review as unreviewed.

## Reuse passing checks

- Compare code, tests, build configuration, and base inputs. Reuse a passing local or CI result that covers the combined inputs.
- If CI already checks those inputs, wait for it. Do not run another full suite locally or update the branch just to trigger checks.
- For documentation or generated-summary conflicts, preserve both changes and run the affected documentation check. Reuse full results if build/test inputs did not change.
- If base code changed, verify the combined code once through CI or a local run.
- AlmaLinux reuse is implemented in [ci-reuse.py](../.github/scripts/ci-reuse.py). It excludes documentation, retains test fixtures, and checks untested base changes. Missing evidence requires full tests; manual/nightly runs always test.

## Gate (once)

- Confirm the expected head SHA and a clean worktree.
- Apply check reuse. Run the repository check on a throwaway merge only when no passing result covers the combined inputs.
- Run affected documentation checks for documentation changes. A full review tier alone does not require a full build.
- Require CI pass/skipping, or recorded passing coverage for a pending duplicate. Never ignore failures. Stop waiting when any check fails.
- No reported checks pass only when no changed file matches a pull-request path filter.
- Require `MERGEABLE` and `CLEAN`. A covered pending duplicate may leave `UNSTABLE`; use normal merge and respect required branch checks.
- Merge with `--match-head-commit`. Never use `--admin` or force.
- Report a failed gate without retrying or starting another fix pass.

## PR comments

- Reviewer: `## Review, round <n>, head <SHA>`.
- Quick reviewer: `## Quick review, round <n>, head <SHA>`.
- Analyzer: `## Analyzer, round <n>`.
- Test and merge: `## Merge gate, head <SHA>`.
