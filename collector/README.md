# Collector

Receive sampler data. Build thread summaries. Store history and serve the dashboard.

<p align="center">
  <img src="../docs/assets/collector-flow.svg" alt="Sampler data arrives over UDP. The collector builds thread state and summaries, writes SQLite day files, and serves the dashboard over HTTP." width="100%">
</p>

## Quick start

1. Run from the repository root:

   ```sh
   scripts/start.sh
   ```

2. Open <http://127.0.0.1:9401>.

The script builds and starts both programs with local configuration files.

## Run separately

Use an existing local configuration:

```sh
make build/triangulator-collector
build/triangulator-collector config/local/collector.toml --check-config
build/triangulator-collector config/local/collector.toml
```

[Configuration example](../config/collector.toml) ·
[Collector reference](../docs/collector-reference.md) ·
[Sampler](../sampler/README.md) ·
[Performance](../docs/collector-comparison.md)
