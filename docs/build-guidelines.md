# Build and checks

## Dependencies

Use Linux, GNU Make 4.2 or later, and a C++23 compiler with the required standard
library support. The [Makefile](../Makefile) checks the compiler before building.
The normal build needs Bash, coreutils, sed, static C/C++ runtime libraries, and
SQLite development files. Tests need Python 3.11 or later and Node.js.
Formatting uses clang-format 22.1.8 and [.clang-format](../.clang-format).

For AlmaLinux package installation and compiler selection, use the maintained
[container setup](../.github/scripts/almalinux-build.sh). It contains the
version-specific package commands. The
[AlmaLinux workflow](../.github/workflows/almalinux-user-test.yml) builds and
tests release binaries in clean containers. Its logs are CI artifacts.

## Commands

```sh
make
make check
```

Select another compiler with `make CXX=g++-14`. Keep compiler selection outside
the Makefile. After C++ changes, run `make format` and `make format-check`.
Use `make check-asan` and `make check-tsan` for separate sanitizer builds.

For a fully static release, run `make release`. If a static SQLite library is
unavailable, run `make sqlite-amalgamation`, then
`make release SQLITE_SOURCE=build/sqlite/sqlite3.c`.
[package.sh](../scripts/package.sh) and the
[release workflow](../.github/workflows/release-package.yml) define the archives.

The optional `make socket-sampler` target needs clang with a BPF backend and
libbpf development files. The [loader](../socket_sampler/main.cpp) checks
required probes and kernel support. `make check-socket-kernel` runs the separate
privileged integration test.

## Performance checks

Use these drivers for current measurements. Inspect their command-line help
for target size, duration, CPU placement, and output options.

| Question | Driver |
| --- | --- |
| Full sampler cost and UDP delivery latency | [benchmark_sampler.py](../tests/benchmark_sampler.py) |
| Thread sampling loop cost | [benchmark_sampling.py](../tests/benchmark_sampling.py) |
| Resource and memory-map sample cost | [benchmark_slow_samples.py](../tests/benchmark_slow_samples.py) |
| Effect on target work and scheduling | [benchmark_target_impact.py](../tests/benchmark_target_impact.py) |

The optional [renderer](../scripts/render_sampler_benchmark.py) creates a local
benchmark page from measured JSON. Generated results stay under `build/`.
Measurements depend on the host, kernel, workload, and rate. They do not define
capacity for other deployments.
