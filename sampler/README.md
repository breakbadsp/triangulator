# Sampler

Read Linux thread and resource data. Send samples to the collector over UDP.

<p align="center">
  <img src="../docs/assets/sampler-flow.svg" alt="The sampler reads the target process through /proc, samples threads at 0.2 to 10 Hz, and sends UDP datagrams to the collector." width="100%">
</p>

## Design constraints

The sampler must keep its overhead on the target host negligible. Run exactly
one sampler on each host, and keep it single-threaded. See
[Sampler constraints](../AGENTS.md#sampler-constraints) and the
[multi-target design](../docs/multi-target-design.md).
The current sampler monitors one target process and its threads. Multi-target
support is proposed. The optional eBPF socket observer is a separate, opt-in
process; see [Socket I/O setup](../docs/setup.md#socket-io-and-messages-processed).

## Quick start

Run these commands from the repository root as the target process user.

1. Start both programs:

   ```sh
   scripts/start.sh
   ```

2. Select a process name or PID:

   ```sh
   scripts/set-target.sh ghostty
   ```

3. Set the sample frequency:

   ```sh
   scripts/set-rate.sh 5
   ```

The default frequency is 5 Hz. The range is 0.2–10 Hz.
Resource samples run every 2 seconds, and memory-map samples every 30 seconds.
Set `resource_interval_s` or `memory_interval_s` to `0` to disable that source.
Both intervals are limited by the thread sampling frequency. See
[target impact](../docs/target-impact.md) for measured costs and limits.

## Run separately

Use an existing local configuration:

```sh
make build/triangulator-sampler
build/triangulator-sampler --check-config ~/triangulator/config/sampler.toml
scripts/start.sh sampler
```

Set `target_process` or `target_pid` in the configuration.
Send `SIGHUP` to apply configuration changes.

[Configuration example](../config/sampler.toml) ·
[Architecture](../docs/architecture.md) ·
[Resource data](../docs/resource-monitoring.md) ·
[Collector](../collector/README.md)
