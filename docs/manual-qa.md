# Manual QA

- Use [Sanity QA](../.agents/skills/sanity-qa/SKILL.md) for a fast package check, or [Senior Manual QA](../.agents/skills/senior-manual-qa/SKILL.md) for feature and regression work.
- The [agent definitions](../.codex/agents/) are the workflow source. Do not repeat their procedure here.
- Select cases from [tiers](qa/tiers.md). Run only the requested scope.
- Use an isolated `TRIANGULATOR_HOME`, unused ports, and owned fixtures. A QA run must not replace the user's installation.
- Test the downloaded binaries. Build only the fixture; record its revision separately from the package version.
- Cases define actions and expected results. [Current results](qa/test-cases.md#current-results) describe tested versions, not the current source.
- Keep evidence for current results. Git history preserves removed run records.
- After recording a run, refresh and validate the README summary with `python3 scripts/qa_summary.py --write-readme --check`.
