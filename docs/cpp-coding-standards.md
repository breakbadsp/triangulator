# C++ coding standards

The shared `cpp-*` skills in [ai-assets at bd5294b](https://github.com/breakbadsp/ai-assets/tree/bd5294bd18bac75898dd1ac60c63f16e25b1ca49)
define the general C++ rules. This link is pinned to that commit, so a later
change to the skills does not change these rules without a review here. Follow the reading and validation steps in
[AGENTS.md](../AGENTS.md). This file contains only Triangulator constraints.

## Project rules

- Use the namespace `triangulator` and the file extensions `.hpp` and `.cpp`.
- Follow `.clang-format` for layout.
- Follow the architecture and sampler constraints in [AGENTS.md](../AGENTS.md).
- Slow helpers must not delay the collector main loop. Publish immutable
  snapshots to the HTTP thread.
- The hot path runs for every datagram or sample. It includes `/proc`
  reads, packet encoding and decoding, and collector state updates.
- The sampler allocates only at startup and reload. See
  [sampler allocation decisions](tigerstyle-adaption.md).
- The collector datagram path allocates only at startup, with the exclusions
  in [collector allocation decisions](collector-allocations.md).
