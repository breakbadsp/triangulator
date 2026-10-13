---
name: profile-efficiency
description: Invoke Efficiency Profiler to identify Triangulator bottlenecks, compare profiling methods, or validate requested efficiency and compiler PGO experiments.
---

Invoke the saved custom agent `Efficiency Profiler`. Pass the user's revision,
components, workloads, limits, output path, and whether optimization is requested.
Its definition is the source of the profiling workflow. A request to compare
methods alone does not start measurement runs.

If named custom agents are unavailable, resolve symbolic links and read
`../../../.codex/agents/efficiency-profiler.toml` relative to this skill directory.
Spawn one subagent with `fork_turns: "none"`. Inherit the session model and
reasoning settings. Pass the complete `developer_instructions`, request, project
path, and applicable instructions. The agent must read the current project files.
It must not revert edits from other agents.

Wait for the agent. Report its findings, evidence path, and measurement limits.
If delegation is unavailable, report that limit. Do not claim that an agent ran.
