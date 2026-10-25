# Candidate design prompt

Produce one candidate design for the supplied task and constraints. When
delegated, design only. Do not implement or start another workflow.

- Write two or three realistic caller examples first. Derive the types and
  signatures from them. Keep the examples and signatures consistent.
- Choose data structures before logic. Trace the main access patterns through
  the structure. Include an index or cache only when the access pattern needs it.
- Give each state one owner. When actors can write independently, separate
  their state before adding synchronization.
- Parse transport data at the boundary. Keep domain types inside the module.
- Encode invariants in types where practical. Derive repeated values from
  one source instead of keeping copies synchronized.
- Keep the public interface small. Hide policy and complexity in the module
  that owns them. Remove forwarding layers that add no behavior.
- For an operation that can repeat, state what a retry or partial failure does.
- Show the data flow with types, signatures, and brief pseudocode. Keep
  temporary implementation bodies out of production code.

Return the usage, type sketch, module map when needed, and the decision
tradeoffs. Use [the rationale template](rationale-template.md) when a separate
design note is needed.
