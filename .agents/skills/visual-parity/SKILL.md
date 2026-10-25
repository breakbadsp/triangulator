---
name: visual-parity
description: Preserve an existing interface during migration with fixed screenshot baselines and repeatable image comparisons.
disable-model-invocation: true
license: MIT
metadata:
  upstream: https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/visual-parity.md
  adaptation: Standalone skill with repository browser tools and bounded verification.
---

# Visual parity

The accepted interface is the baseline. Establish it before migration.
Verify equivalence with image comparisons, not visual inspection alone.

1. Capture the current interface across its relevant states. Use the same
   browser version, viewport, pixel ratio, fonts, theme, and fixture data for
   both implementations. Fix the clock and animation state where needed.
   Use the repository browser workflow and screenshot comparison tools.
   If these prerequisites are missing, establish them before migration.
2. Keep baseline images and comparison settings unchanged during migration.
   Do not weaken the comparison or change fixtures to hide a difference.
   If the baseline is wrong, obtain agreement on the intended result before
   changing it. Keep an intentional redesign separate from a parity claim.
3. Migrate shared primitives first, then one component or a small group at a
   time. Give each component one owner. Follow repository delegation rules.
4. Run the same screenshot cases against the migrated interface. Investigate
   each difference. Use zero changed pixels by default. Set any necessary
   rendering tolerance before migration and explain it. Do not increase it
   to make a failing comparison pass.
5. Verify interactions in the running interface. Include keyboard access,
   focus, loading, empty, error, and live update states where applicable.
   A matching screenshot does not prove working behavior.
6. Follow repository checks and delivery rules. If comparison remains blocked
   or fails after the bounded repair work, report the failure and evidence.
   Do not claim parity without a passing comparison.

Report the components checked, comparison results, baseline and diff paths,
and any remaining failures. Follow project requirements for help topics and
manual QA cases when behavior changes.
