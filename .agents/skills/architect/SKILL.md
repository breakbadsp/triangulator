---
name: architect
description: Design caller usage, types, signatures, and module boundaries before a substantial implementation or redesign.
disable-model-invocation: true
license: MIT
metadata:
  upstream: https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/SKILL.md
  adaptation: Self-contained workflow with repository model, delegation, and shipping rules.
---

# Architect

Settle the shape of the code before implementation. Start with caller usage.
Derive types and module boundaries from that usage.

## Phase A: Ground the problem

Read the relevant callers, implementation, tests, and design constraints.
Trace the data flow and identify who owns each state. Use source history when
the reason for an existing boundary affects the new design.

Skip this phase only for new code with no surrounding system to integrate.

## Phase B: Sketch

Compare at least two different structures. A change to a name or parameter
order is not a different structure. Keep each sketch small.

Use [the candidate prompt](references/runner-prompt.md) for each sketch.
Follow the repository model and delegation rules. Use independent agents
when delegation is available and authorized. Otherwise, compare the sketches
in the current session. Do not require a particular provider or model.

Screen each candidate with [the design checks](references/design-red-flags.md).
Choose the structure that hides the required complexity behind the smallest
useful interface. Record why an alternative lost.

## Phase C: Agree

Continue to implementation unless the user requested a design checkpoint.
When the user asks for design only, stop after the sketch.

Use [the rationale template](references/rationale-template.md) only for
decisions that code cannot show. Keep a small decision in the PR description
or a short comment. Do not create a separate document without a need.

## Phase D: Implement

Implement against the selected usage and types. Use temporary stubs only in
the sketch or where the repository permits them. Do not ship stubs.

If implementation repeatedly needs casts, extra flags, or caller knowledge
of internal stages, check the design again. Repeated workarounds indicate a
wrong structure. Return to Phase A with the new evidence, then revise the
sketch. Do not add layers to preserve a failed design.

## Verification and delivery

Run the relevant behavior checks against the working implementation. Follow
the repository check and PR workflow. This skill does not authorize a merge
or other external action.

Report the chosen structure, the tradeoff, and the verification result.
