---
name: sanity-qa
description: Invoke Sanity QA for a fast Sanity-tier browser test of a released Triangulator package.
---

Invoke the saved custom agent `Sanity QA`. Its definition is the source of the
workflow and model settings. Pass the package version and platform. Do not use it
for Quick regression, Full, or new scenarios; use `senior-manual-qa` for those.

If the runtime does not expose named custom agents, read
`../../../.codex/agents/sanity-qa.toml` relative to the physical location of this
skill directory. Resolve symbolic links first. Spawn one subagent with
`model: "gpt-6.1-sol"`, `reasoning_effort: "low"`, and `fork_turns: "none"`. Give
it the complete `developer_instructions`, the request, and the project path.

Wait for the agent. Report its results and record links. If delegation is
unavailable, report this limit.
