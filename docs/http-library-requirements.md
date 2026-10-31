# Requirements for replacing the collector HTTP server

This is a planning inventory of current behavior. It does not start the
migration or approve new API features. A third-party HTTP library can own
message parsing and delivery. Triangulator must still own its application
rules and set explicit resource limits.

## Application behavior to retain

| Item | Requirement when using a library | Reason |
| --- | --- | --- |
| Embedded dashboard | Keep the dashboard in the collector binary. Serve `/` without a runtime file dependency. | Preserve single-binary deployment. |
| API contract | Retain route methods, JSON fields, target selection, and application errors. Change a client and its tests with any intentional contract change. | The dashboard and other clients depend on this contract. |
| Live snapshots | Read immutable published snapshots for live data, the last target, memory maps, and fleet data. Release shared-state locks before sending responses. | A slow client must not hold up sample collection. |
| Stored data | Retain target filters, recorded-target lookup, and legacy replay merging. Keep history and replay reads in HTTP workers. | Preserve historical data access without moving disk work into the receive loop. |
| Query interpretation | Preserve the first non-blank query value, percent decoding, and `+` as a space. Preserve existing numeric input rules unless clients and tests change together. | A library can interpret duplicate, blank, or encoded parameters differently. |
| Data validation and limits | Keep valid time-range and retention checks, the 2,000-row thread-history limit, and the resource-history scan limit of 200,000 rows with approximately 1,000 time buckets. Retain truncation and read-error fields where provided. | Bound query work and tell clients when results are incomplete. |
| Browser write protection | Keep `X-Triangulator: 1` on POST routes. If `Origin` is present, require the current allowed origin check. Do not enable cross-origin writes through a library default. | Preserve the current protection against unwanted browser writes. These checks do not authenticate an application. |
| Target-control policy | Use the actual socket peer for the loopback restriction unless `network_target_control` permits network access. Do not trust forwarded-address headers by default. | A library or proxy must not silently expand access to sampler control. |
| Target changes | Retain local-sampler checks, target ID and rule checks, target-count limits, and removal tied to the published sessions. Keep the helper and bounded collector-removal queue. | A stale request must not remove a newly added session or alter a remote sampler. |
| Watch changes | Keep per-target settings, validation, atomic revision comparison and publication, persistence, reset behavior, and revision invalidation after restart. | Concurrent editors must not overwrite newer settings. |
| Partial application errors | Retain `applied` and `applied_state` where supplied after a persistence or cleanup failure. | An error can occur after a change takes effect. Clients must not assume every failure means no change. |
| Response policy | Keep explicit content types, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and the dashboard Content Security Policy. Apply the intended policy to library-generated errors too. | Replacing response formatting must not remove browser protections or permit stale live data. |

The current route groups are:

- Dashboard: `GET /`.
- Live data: `GET /api/live`, `/api/last-target`, `/api/memory-map`,
  `/api/targets`, and `/api/fleet`.
- Stored data: `GET /api/history`, `/api/resources`, and `/api/replay`.
- Target control: `GET /api/target`, `GET /api/targets/control`,
  `POST /api/target`, and `POST /api/targets`.
- Watch settings: `GET /api/watches`, `POST /api/watches`, and
  `POST /api/watches/reset`.

Sources: [HTTP handlers](../collector/http.hpp),
[shared state](../collector/shared_state.hpp),
[watch settings](../collector/watch.hpp), and
[target-control helper](../collector/target_control.hpp).

## Resource and lifecycle policy to configure

These limits are Triangulator policy. A library must not replace them with
unlimited queues or different timeout meanings without an explicit decision.

| Current behavior | Migration requirement |
| --- | --- |
| At most 64 active connection workers; listener backlog 128. | Set explicit worker, active-connection, and pending-work limits. The current server has no application task queue. Persistent connections must count against a bound. |
| When all slots are busy, attempt an immediate nonblocking `503`, then close. | Define and test overload rejection and recovery. The current best-effort response is not guaranteed to arrive. |
| Request bodies have a 16 KiB limit. | Set the library body limit explicitly. Bound decoded bodies too if compression or other body transformations are enabled. |
| The parser checks accumulated request data against 65,536 bytes while waiting for the header terminator. Reads use 4,096-byte buffers. This is not an exact header-size limit. | Set an explicit header-size limit. Do not copy the current check's possible overshoot. |
| One five-second total read deadline covers both headers and body, starting when a worker creates the connection wrapper. | Preserve a total deadline. A timeout that resets after each read is insufficient for a client that sends bytes slowly. |
| A separate five-second total deadline covers response writes. | Bound the complete write, including clients that make slow progress. Neither network deadline currently limits handler execution time. |
| Stop interrupts pending network waits and joins the listener and workers. | Retain prompt shutdown with incomplete requests. Stop workers before destroying the state they use. |
| HTTP workers run separately from UDP ingestion. | Keep parsing, queries, helper calls, and socket waits outside the collector receive loop. |
| HTTP binds to `http_host` and `http_port`; address selection supports IPv4 and IPv6. Bind failures stop startup. | Preserve configuration, peer-address handling, and visible startup failure. |
| The collector embeds the dashboard and supports a fully static release build. | Compile the library into the collector. Verify the release has no dynamic dependencies. Optional TLS or compression dependencies need an explicit decision. |

Sources: [server and parser](../collector/http.hpp),
[connection deadlines](../collector/http_connection.hpp),
[startup](../collector/main.cpp), and [release build](../Makefile).

## HTTP behavior for the library to handle

Use the library for request parsing, header syntax, message framing,
partial socket I/O, response serialization, and connection management.
Remove the replaced custom transport code during a later migration.

Do not treat current parser gaps as compatibility requirements. Verify
request versions, `Host` validation, header syntax, `HEAD` responses, and
required response headers against the selected library version.

The current server sends HTTP/1.0 responses and closes each connection after
one request. It rejects every `Transfer-Encoding` header. Before enabling
HTTP/1.1 features, test chunked request bodies and connection reuse against
the resource policy above. Decide whether to support `Expect: 100-continue`.
Disable unused file serving, uploads, compression, streaming, or protocol
upgrades rather than enabling new features as part of the replacement.

Watch updates currently require a quoted `If-Match` revision. Missing
revisions return `428`; stale revisions return `409`. Decide how to move
failed preconditions to standard `412` behavior and whether to support the
full `If-Match` syntax. Update clients, tests, and the existing
[watch revision instructions](../collector/README.md#multiple-viewers)
together. An HTTP library cannot make this application decision.

## Separate integration decisions

The current server has no credential authentication, built-in TLS, or
general idempotency-key mechanism. JSON handlers do not enforce the request
`Content-Type`. These are existing gaps, not behavior supplied automatically
by a new HTTP library.

Before exposing write APIs to other applications, define authentication,
permissions, accepted body formats, and retry behavior. Decide where HTTPS
terminates. If a proxy is used, define which peers and forwarded headers
are trusted. The current loopback target-control rule alone cannot identify
the original client behind a local proxy.

## Verification before migration completion

- Run [HTTP concurrency tests](../tests/test_dashboard_concurrency.py) for
  independent clients, slow headers and bodies, shutdown, overload recovery,
  and competing watch editors.
- Run [multi-target tests](../tests/test_multitarget.py),
  [monitor tests](../tests/test_monitor.py), and
  [collector tests](../tests/collector_test.cpp) for application behavior.
  Existing tests are a baseline, not proof of complete HTTP conformance.
- Add real-socket checks for protocol behavior, browser write protection,
  actual peer restrictions, request-size limits, response headers, and each
  intentionally changed status code. Use the actual integrating clients too.
- Run `make check` and `make release`. Inspect the resulting binary for
  runtime dependencies. Compare CPU use, memory use, HTTP latency, and sample
  ingestion under the same load before and after replacement. A library
  choice alone does not prove equivalent performance.
