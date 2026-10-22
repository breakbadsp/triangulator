# LoomFlow

- This is the tool-neutral review workflow. Use `git` and `gh`; take checks, standards, and sensitive paths from the repository's `AGENTS.md`.
- Claude Code adapter: [command](../.claude/commands/loomflow.md) and [role prompts](../.claude/agents/).
- Roles: orchestrator selects and coordinates; reviewers stay read-only; analyzer fixes or rebuts; test-and-merge runs the gate once.
- Only the user starts a run. Roles never start LoomFlow. Maximum: two review rounds and one merge gate.

## Select the review

- Use `scan` only when no sensitive path changes and either all files are documentation or at most 30 lines change in at most three files.
- Sensitive paths include CI, build files, dependency manifests/locks, auth/secrets, storage/wire formats, and the repository's list. Documentation on these paths still needs `full`.
- Use `full` for every other change or any doubt. A user-requested `full` cannot be downgraded.
- `scan` uses one reviewer. `full` uses two reviewers in parallel on the same head SHA.

## Model and reasoning selection

Pick the models from the size of the change. Pass the model and effort to every role; role defaults are only fallbacks.

| Size | When | Reviewer A | Reviewer B | Analyzer | Gate |
| --- | --- | --- | --- | --- | --- |
| Small | `scan` | Haiku 5.5, medium | none | Sonnet 5.5, medium | Haiku 5.5, low |
| Normal | other `full` changes | GPT 6.1 Sol or Sonnet 5.5, medium | Haiku 5.5, medium | Sonnet 5.5, medium | Haiku 5.5, low |
| Major | a new feature or redesign; any change on a sensitive path; concurrency, storage, wire format, auth, or secrets; or more than 300 changed code lines | GPT 6.1 Sol, high (Opus 5.5, high, when Sol is unavailable) | Sonnet 5.5, high | Sonnet 5.5, high | Haiku 5.5, low |

- Use two model families for A and B when possible. In any doubt between two sizes, use the larger one.
- Never use Astra 6, also not as a fallback. Never use effort above `high`.
- Haiku does the gate and other mechanical work: its runs stay far below its context limit, and they need no deep reasoning. It is not a reviewer for major changes.
- Lower the effort, never the size, when the token budget is low.

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
