# Collector decisions

- Keep receive, storage, and API work in C++ because they process high sample rates. Historical evidence: [collector comparison](collector-comparison.md).
- Keep alert evaluation and delivery outside the collector. Slow external services must not delay packet processing.
- Publish immutable views to HTTP workers. Browser requests must not hold the receive loop while reading state.
- Record complete views for replay. Thread rollups alone cannot reproduce the dashboard at a past time.
- Let reports read SQLite day files or the API. They must not add work to the UDP receive path.
- Keep reports read-only. One writer owns history; independent analysis must not alter evidence.
- Reserve bounded datagram-path storage at startup. See [allocation decisions](collector-allocations.md) for rejected alternatives and contract exclusions.
- Implementation details: [collector README](../collector/README.md), [configuration](../config/collector.toml), and [source](../collector/).
