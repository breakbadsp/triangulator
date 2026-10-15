# Triangulator

Triangulator shows Linux process and thread activity, resource pressure, and
recorded history. The sampler reads `/proc`. The collector stores SQLite history
and serves the dashboard. Alert delivery is not connected.

## Start

Install the [build requirements](docs/build-guidelines.md), then run as the
user that owns the target process:

```sh
scripts/start.sh
scripts/set-target.sh 1234
```

Replace `1234` with the target PID or use an exact process name.
Open <http://127.0.0.1:9401>. Use `scripts/stop.sh` to stop the programs.
For binary packages and separate hosts, see [setup](docs/setup.md).

## Find the source

- [Architecture and code map](docs/architecture.md): data flow and ownership.
- [Measurement limits](docs/measurement-limits.md): what observations can prove.
- [Configuration](config/): supported settings and examples.
- [Build and checks](docs/build-guidelines.md): tools and test entry points.
- [Manual QA](docs/manual-qa.md): browser checks that need human observation.
- [Planned work](TODO.md): remaining requirements.

The dashboard information buttons explain metrics and their limits.
Implementation details, protocol fields, API routes, and storage schemas belong
in the source files linked from the code map.
