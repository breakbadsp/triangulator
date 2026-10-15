# Setup

## Local source checkout

Follow [build requirements](build-guidelines.md), then use the commands in the
[README](../README.md#start). Run the sampler as the target process user.

The runtime defaults to `~/triangulator`. Set `TRIANGULATOR_HOME` for an isolated
installation. Active configuration is under `config/`; logs are under `logs/`.
Use [start.sh](../scripts/start.sh), [stop.sh](../scripts/stop.sh), and
[restart.sh](../scripts/restart.sh) to control the programs.
[Runtime path handling](../scripts/runtime.sh) defines the directory layout.

Edit the active files, rather than the repository examples. See
[sampler.toml](../config/sampler.toml) and
[collector.toml](../config/collector.toml) for settings.
Use [set-target.sh](../scripts/set-target.sh) and
[set-rate.sh](../scripts/set-rate.sh) for target and rate changes.

## Release packages

Download matching sampler and collector archives and their `.sha256` files
from [GitHub Releases](https://github.com/breakbadsp/triangulator/releases).
Verify each archive with `sha256sum -c FILE.sha256`, then extract it into the
same installation parent directory. The archives contain `triangulator/`.
Run `~/triangulator/scripts/start.sh` and open <http://127.0.0.1:9401>.
The binaries are static. Target and rate control require Python 3.11 or later.

For an upgrade, stop the programs, extract the new archives over the existing
installation, then start again. Packages exclude active configuration, data,
and logs. See [package.sh](../scripts/package.sh) for package contents.

## Separate hosts

Install the sampler on the target host and the collector on the monitoring host.

- Set the sampler's `collector` to the collector's numeric IP and UDP port.
- Set the collector's `udp_host` to the receiving interface and `sampler_ip`
  to the source IP that it will see. Permit this UDP traffic through the firewall.
- Set `clock_ticks` to the target host's `getconf CLK_TCK` value.
- Keep HTTP on loopback. Use an SSH tunnel for remote dashboard access:

```sh
ssh -N -L 9401:127.0.0.1:9401 USER@COLLECTOR_HOST
```

Neither UDP nor HTTP has authentication. Use a trusted network for samples.
Use an SSH tunnel or an authenticating proxy for dashboard access.

## Services and optional sources

The [deploy/](../deploy/) directory contains user service units. Install only
the required units on each host. Stop script-managed processes before enabling
services. Use `systemctl --user` for later service control. Keep the runtime
path consistent with the unit files.

The optional socket observer needs BPF privileges and compatible kernel probes.
See [build guidelines](build-guidelines.md) and
[watch-sockets.sh](../scripts/watch-sockets.sh) for its entry points.
Read [measurement limits](measurement-limits.md) before interpreting missing
socket or process exit evidence.

## Recorded views

Use the **Timeline** at the top of the dashboard to inspect a recording.
Drag its handle back and release it, or select a row under **Past assessments**.
The dashboard shows the nearest recording at or before the selected time.
Use **◀** and **▶** to step between recordings. Select **Live**, **Back to live**,
or release the handle at the right end to return to the live view.

Scroll to the end of the findings list, select **Load earlier**, or release the
handle at the left end to check an earlier period. Severity and type filters
apply to both the list and the timeline marks. Read the contextual help and
[measurement limits](measurement-limits.md#sampling-and-history).
