# Build guidelines

Triangulator requires Linux and GCC/libstdc++ 13 or later.
The code uses C++23 `std::expected`, `std::format`, and `std::byteswap`.
The AlmaLinux container test verified the normal build and static release on
AlmaLinux 9.8 and 10.2, on x86-64.
See [the test report](almalinux-user-test.md) for the evidence and test limits.

## Dependencies

- Checkout: Git.
- Build: GNU Make 4.2 or later, a C++23 compiler, Bash, coreutils, sed, static C/C++
  runtime libraries, and SQLite development headers and library.
- Release verification: binutils, including `readelf`.
- Tests: Python 3.11 or later and Node.js. No Python packages are required.
- Formatting: clang-format 22.1.8 with the repository's `.clang-format` file.
- Fully static release: a static SQLite library, or `sqlite3.c` and `sqlite3.h`
  from the same SQLite amalgamation archive.
  The selected C++ compiler compiles this source as C.

Make compares saved build options without an external command.
The build does not require `cmp` or diffutils.
The dashboard tests require Node.js. An absent Node.js executable fails the tests.
The optional eBPF kernel test is separate and remains disabled in normal checks.

## Install packages in AlmaLinux

Run these package commands as root inside the build container or build machine.
Compile and run Triangulator as an ordinary user.
The sampler and target process must run as the same user.
The CI [runner pool](self-hosted-runner.md) creates these containers rootless.
Fork pull requests use GitHub-hosted runners. You need no local Docker access
or `sudo` to run the workflows.

### AlmaLinux 8

The default GCC 8 compiler cannot build this project.
Install GCC Toolset 14 and select Node.js 22 from the module repository.

```sh
dnf install -y dnf-plugins-core git make coreutils sed binutils gcc-c++ sqlite-devel
dnf config-manager --set-enabled powertools
dnf module enable -y nodejs:22
dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel glibc-static libstdc++-static python3.11 nodejs
```

PowerTools supplies the static development packages on AlmaLinux 8.

### AlmaLinux 9

The default GCC 11 compiler cannot build this project.
Install GCC Toolset 14 and select Node.js 22 from the module repository.
AlmaLinux includes [Node.js 22](https://wiki.almalinux.org/release-notes/9.6).

```sh
dnf install -y dnf-plugins-core git make coreutils sed binutils gcc-c++ sqlite-devel
dnf config-manager --set-enabled crb
dnf module enable -y nodejs:22
dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel glibc-static libstdc++-static python3.11 nodejs
```

CRB is the AlmaLinux repository that supplies the static development packages.
The selected compiler also compiles the SQLite amalgamation as C.

### AlmaLinux 10

The default GCC 14 compiler supports the required language features.
Static runtime libraries still need a separate package installation.

```sh
dnf install -y dnf-plugins-core git make coreutils sed binutils gcc-c++ sqlite-devel
dnf config-manager --set-enabled crb
dnf install -y glibc-static libstdc++-static python3 nodejs
```

## Select the tools and build

1. Clone the project as an ordinary user.

   ```sh
   git clone https://github.com/breakbadsp/triangulator.git
   cd triangulator
   ```

2. On AlmaLinux 8 and 9, select GCC Toolset 14 and Python 3.11 for this shell.

   ```sh
   mkdir -p config/local/build-tools
   ln -sfn /usr/bin/python3.11 config/local/build-tools/python3
   export PATH="$PWD/config/local/build-tools:$PATH"
   export CXX=/opt/rh/gcc-toolset-14/root/usr/bin/g++
   ```

   This local alias leaves the operating system's `python3` executable unchanged.
   AlmaLinux 10 needs no tool selection step.

3. Check the selected tool versions.

   ```sh
   "${CXX:-c++}" --version
   python3 --version
   node --version
   ```

4. Build the three normal programs.

   ```sh
   make
   ```

5. Run the C++, Python, and dashboard tests.

   ```sh
   make check
   ```

6. Start the collector and sampler with local configuration files.

   ```sh
   scripts/start.sh
   ```

7. Select the process to monitor.

   ```sh
   scripts/set-target.sh PROCESS_NAME_OR_PID
   ```

8. Open `http://127.0.0.1:9401` in your browser.

The startup script preserves existing local configuration files.
The command-line control scripts and local dashboard target control need Python.
An absent target name is accepted and waits for the process to start.
See [configuration](setup.md#configuration) for separate hosts and custom paths.

## Run tests with sanitizers

Install the address and thread sanitizer runtimes for the selected compiler.
Run both sanitizer modes:

```sh
make -j2 check-sanitizers
```

The command runs AddressSanitizer with UndefinedBehaviorSanitizer, then
ThreadSanitizer. Each mode runs all six C++ tests, the Python tests, and the
dashboard JavaScript tests. The Python and JavaScript interpreters retain their
normal runtimes. C++ programs that their tests start use sanitizer instrumentation.
Both allocation tests keep their assertions and use sanitizer allocation hooks.
The thread mode uses `-O0` to avoid GCC 14 diagnostics in `std::variant` moves.
Compiler warnings and `-Werror` remain enabled.
Benchmark fixtures reserve thread slots for sanitizer runtime threads. Their
measurements include sanitizer overhead and must not replace performance baselines.

To run one mode, use `make check-asan` or `make check-tsan`.
You can also use `make check SANITIZER=address` or `make check SANITIZER=thread`.
The build changes to dynamic libc and C++ runtime linkage for these modes.
`STATIC=1` is rejected. Build options cause a rebuild when the mode changes.
Run `make check` to return to the normal build.
The combined command runs the modes in sequence, including with `make -j`.
Do not run separate build commands concurrently in the same checkout.

Sanitizer errors stop the affected process. Leak detection is enabled for the
address mode. Reports from all child processes are stored in
`build/sanitizer-reports/MODE/run-*/`. Any nonempty report fails the check,
including when a test discards child stderr or accepts a nonzero exit status.
Caller runtime options are retained, followed by required failure and report options.

The optional eBPF kernel test needs its usual privileges. To instrument its
user-space programs, run `make check-socket-kernel SANITIZER=address` or
`make check-socket-kernel SANITIZER=thread`. The kernel BPF object cannot use
these user-space sanitizer runtimes.

ThreadSanitizer needs a compatible virtual address layout. A startup error such
as `unexpected memory mapping` is a runtime failure, not a successful check.
The sanitizer CI job uses a dedicated runner and sets `vm.mmap_rnd_bits=28`
for the thread mode. Local checks do not change host settings.
Sanitizers test only executed paths. A successful run does not prove that all
memory errors or data races are absent. See the
[AddressSanitizer documentation](https://clang.llvm.org/docs/AddressSanitizer.html)
and [ThreadSanitizer documentation](https://clang.llvm.org/docs/ThreadSanitizer.html)
for detection and runtime limits.

## Build a fully static release

The normal sampler is fully static.
The normal collector and socket report helper embed the C++ runtime, but still
use shared SQLite and glibc libraries, including libc and libm.
Use `make release` when the deployment must need no shared libraries.
The release target rejects binaries with a dynamic loader or shared dependencies.

If the system supplies `libsqlite3.a`, run:

```sh
make release
make check STATIC=1
```

The tested AlmaLinux package setup did not supply this static SQLite library.
Use the verified download target:

```sh
make sqlite-amalgamation
make release SQLITE_SOURCE=build/sqlite/sqlite3.c
make check STATIC=1 SQLITE_SOURCE=build/sqlite/sqlite3.c
```

To supply the source manually:

1. Download a release archive from the [SQLite download page](https://www.sqlite.org/download.html).
2. Verify the archive against its published SHA3-256 hash.
3. Extract `sqlite3.c` and `sqlite3.h` into the same directory.
4. Build and test with that source file.

   ```sh
   make release SQLITE_SOURCE=/absolute/path/to/sqlite3.c
   make check STATIC=1 SQLITE_SOURCE=/absolute/path/to/sqlite3.c
   ```

The GitHub test uses SQLite 3.53.4 and verifies its published archive hash.
The build disables SQLite dynamic extension loading for this option.
Link mode and compiler flags are tracked, so the binaries rebuild when these change.

Copy the collector and `triangulator-socket-report` into the same directory.
The sampler can run on a separate host with its configuration file.
The copied monitoring binaries need no Python or Node.js.
Use numeric UDP and HTTP addresses for static deployments.
See [production setup](setup.md#production-setup) for the service templates.

## Required quality checks

Keep the C++23 requirement, compiler warnings, `-Werror`, and static sampler linkage.
Keep the release dependency verification enabled.
Use clang-format 22.1.8 for local checks and CI.
Formatter versions can produce different layouts for the same configuration.
CI selects the exact version with the [clang-format package](https://pypi.org/project/clang-format/22.1.8/)
through `pipx`. Developers with `pipx` can use the same commands:

```sh
make format CLANG_FORMAT='pipx run --spec clang-format==22.1.8 clang-format'
make format-check CLANG_FORMAT='pipx run --spec clang-format==22.1.8 clang-format'
```

Run `make format` and `make format-check` for C++ changes.
Run `make check` before each commit.
Run `make check` with the same static options as the release build.
Confirm that the dashboard tests ran.
Run the AlmaLinux workflow for build, sampler, collector, helper, and test changes.
Its clean deployment container runs the copied release binaries as UID 1000,
without package installation or Linux capabilities.

If the optional eBPF source changes, also run `make check-socket-kernel` on a
host with the required kernel features and permissions.
See [the socket source guide](socket-ingress-design.md#build-and-run).

## Errors and remaining release work

- `make: command not found`: install Make.
- `fatal error: expected: No such file or directory`: select a supported C++23 compiler.
- `cannot find -lstdc++`, `-lm`, or `-lc` in a static build: install the static runtime packages.
- `cannot find -lsqlite3` in `make release`: supply static SQLite or use `SQLITE_SOURCE`.
- Dashboard tests report missing Node.js: install Node.js and repeat `make check`.

The container tests use the GitHub runner's kernel.
They do not establish the oldest supported Linux kernel or CPU architecture.
They also do not test AlmaLinux SELinux policy or the systemd service templates.
Before publishing supported release binaries, define the minimum kernel and
architecture, and validate the binaries and service setup on those systems.
Publish release archives with configuration examples and checksums after these checks pass.
See [deployment work](../TODO.md#deployment-dependencies) for the remaining tasks.
