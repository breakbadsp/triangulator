# Design decisions

## Production cost

- Use one unprivileged sampler per host. A process per target would repeat scans and increase cost.
- Use one thread and monotonic deadlines. This keeps scheduling and shared state simple.
- Send raw counters over non-blocking UDP. Production hosts must not wait for the collector or write history to disk.
- Accept packet loss. Reliable delivery and local buffering would add work to the monitored host.
- Compute rates and findings away from the target. Keep interpretation out of the sampler.
- Bound storage and scans. A large target must not cause unbounded work or allocation.
- Use C++ or Rust for high-rate processing. See [collector decisions](collector-reference.md) for evidence and analysis boundaries.
- Use static release binaries. Production hosts must not need a language runtime or shared libraries.

## Identity and history

- Give each target a sampler session. Existing packet formats already use sessions to separate process lifetimes.
- Keep target selection in each browser tab. One viewer must not change another viewer's investigation.
- Keep the final process view until Show live. An automatic switch could replace failure evidence with a restarted process.
- Ask for confirmation when changing the monitored target set. This changes collection for every viewer.
- Keep findings derived from recordings in the browser. They are interpretations of saved evidence, with [sampling limits](measurement-limits.md).
- Keep old wire formats readable during upgrades. A collector-only upgrade must not require a sampler upgrade.

## Memory

- Read mappings without stopping the process. The cost is bounded observation with incomplete evidence.
- Do not infer a heap leak or stack depth from virtual mappings. Address reservation and resident use have different meanings.
- Keep detailed memory reports outside the collector loop. Analysis must not delay packet processing.
- An earlier memory-map proposal selected a request channel and a sampler thread. It was not implemented and conflicts with the current single-thread rule. It is not an approved exception.
- That proposal rejected `smaps` for a selected mapping: the kernel must traverse earlier mappings. Address-indexed `pagemap` can limit the read, but does not provide PSS or dirty size.

## Sockets and process exits

- Keep eBPF optional. Requiring it would remove the unprivileged deployment path.
- Use socket operation results for per-thread byte counts. Transport receipt and `/proc/io` do not establish application consumption.
- Require an explicit application marker for completed messages. Bytes and receive operations do not establish message completion.
- Use socket-length tracepoints to include internal batched send and receive paths. Public socket entry points alone miss some operations.
- Never treat a futex wait as proof of deadlock. An idle worker can have the same kernel wait channel.
- Treat kernel logs as optional exit evidence. Broad kernel-log access changes host policy and must not be required for monitoring.

## Delivery and CI

- Keep UDP and HTTP on trusted networks. They have no authentication; use loopback HTTP and an SSH tunnel for remote access.
- Run fork pull requests on GitHub-hosted runners. Untrusted code must not run on the owner's host.
- Use an unprivileged runner account and rootless containers. CI must not receive host administrator rights.
- Separate package and test compiler caches because container users differ. Shared cache ownership must remain stable while jobs run.
- Reuse passing checks only when code, tests, build inputs, and the base are covered. A documentation change alone does not need another full test run.
