---
name: senior-manual-qa
description: Invoke Senior Manual QA to test a package in a real browser or maintain manual test scenarios for a new feature.
---

Invoke the saved custom agent `Senior Manual QA`. Its definition is the source
of the QA workflow and model settings. Pass the user's package, version, feature,
and scope. Do not start a QA run when the request only asks to document scenarios.

If the runtime does not expose named custom agents, read
`../../../.codex/agents/senior-manual-qa.toml` relative to the physical location
of this skill directory. Resolve symbolic links first. Spawn one subagent with
`model: "gpt-6.1-sol"`, `reasoning_effort: "medium"`, and `fork_turns: "none"`.
Give it the complete `developer_instructions` from the definition, the request,
the project path, and applicable instructions. The subagent must read the project's
current files. Do not replace the requested model if it is unavailable.

Wait for the agent. Report its results and artifact links. If delegation is
unavailable, report this limit. Do not claim that a skill changes the current
session's model or that an agent was started.
