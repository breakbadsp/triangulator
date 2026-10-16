# Senior Manual QA

The reusable agent tests a downloaded package through a real browser.
It uses `gpt-6.1-sol` with `medium` reasoning.
The [agent definition](../.codex/agents/senior-manual-qa.toml) contains the workflow.
The [invocation skill](../.agents/skills/senior-manual-qa/SKILL.md) starts that agent
in clients that support delegation.

Start a new Codex or T3 Code session after installation. Example requests:

```text
Use $senior-manual-qa to test the latest stable Triangulator package.
Run the Sanity tier in a real browser and update the results.
```

```text
Use $senior-manual-qa to test package VERSION for PLATFORM.
Test FEATURE and the affected existing cases. Add missing scenarios.
```

```text
Use $senior-manual-qa to document scenarios for FEATURE. Do not run tests yet.
```

Replace `VERSION`, `PLATFORM`, and `FEATURE` with the requested values.
QA runs start when requested. A feature change adds test definitions through
the project instructions; it does not start an unattended package test.

## Personal installation

The project agent and skill are available from this checkout. To use them in
other projects, link them into the personal agent and skill directories.
Run this from a checkout that you intend to keep. If a destination exists,
inspect it before changing it.

```sh
mkdir -p ~/.codex/agents ~/.agents/skills
ln -s "$PWD/.codex/agents/senior-manual-qa.toml" ~/.codex/agents/senior-manual-qa.toml
ln -s "$PWD/.agents/skills/senior-manual-qa" ~/.agents/skills/senior-manual-qa
```

The links use one workflow source. If you remove the source worktree after
merge, first change both links to the retained checkout of the merged commit.
Do not change the global model or enable unrelated plugins.

Codex documents [custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)
and their model settings. GPT-6.1-Sol supports
[medium reasoning](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
The client must support delegation and have access to the requested model.

## Run tiers

The agent runs [Sanity](qa/tiers.md) by default: four cases in about 10 minutes.
Ask for "quick regression" to add eight more cases, or "full" for every case.
Each tier is defined in [qa/tiers.md](qa/tiers.md). Example:

```text
Use $senior-manual-qa to run quick regression on the latest stable package.
```

## Triangulator suite

Use [manual test cases](qa/test-cases.md). The cases cover documented installation
and dashboard behavior, plus the PR #47 bug lab. The table links the latest
result for each case to its versioned run record.
Historical observations in `docs/bug-lab-report.md` and
`docs/buggy-workload-evaluation.md` remain separate.

Download the matching sampler and collector packages for one version and
platform. Use the release assets and verify both `.sha256` files. Follow
[package installation](setup.md#install-from-a-release-package).
Use an isolated `TRIANGULATOR_HOME` and unused ports. Do not replace the user's
`~/triangulator` installation. The startup scripts accept that runtime directory.

Each result records Status and Tested package version beside its case ID.
Each run adds a record in `docs/qa/runs/` with evidence and reproduction steps.
A failed case keeps its failed run after a later package passes.
The package version identifies the tested software. The case revision identifies
the test definition. QA does not change the package version.

## Check results on GitHub

- Open the [README test results](../README.md#test-results) for counts by status
  and the IDs of failed, blocked, and unrun cases.
- Open the [current-result table](qa/test-cases.md#current-results). Each row links
  the latest run and its evidence. Open the [run records](qa/runs/) for steps,
  environment, package identity, and failure reproduction.
- The [QA results workflow](https://github.com/breakbadsp/triangulator/actions/workflows/qa-results.yml)
  runs on every change to these files. It fails when a recorded result row is
  invalid, a run or evidence link is broken, or the README summary is stale.
  Case procedures can exist without result rows. Its job summary shows the counts.
- Locally, run `scripts/qa_summary.py` to print the counts. After a QA run, run
  `scripts/qa_summary.py --write-readme` to refresh the README block, then
  `scripts/qa_summary.py --check`.

## Sample workload from PR #47

Use [`bug-lab/bugbench.c`](../bug-lab/bugbench.c), introduced by
[PR #47](https://github.com/breakbadsp/triangulator/pull/47), as the standard
sample workload. It provides 19 fault scenarios and a healthy control.
The runner adds a stopped-process case. The
[bug lab cases](qa/bug-lab-cases.md) define one test for each scenario.

Compile only the sample workload. Keep the downloaded sampler and collector
binaries as the product under test. Record the fixture source revision separately
from the package version. Use the packaged control scripts to select the fixture
by PID. Keep the browser open while each scenario runs so the charts retain
their observations. Use T3 preview tools for the browser checks.

The existing `bug-lab/run-lab.sh` uses the repository's control script and starts
its own Chromium capture process. Read it for setup, timing, and cleanup details.
For agent QA, execute those setup steps with the packaged scripts and the shared
T3 browser. Save new evidence beside the new run record.
