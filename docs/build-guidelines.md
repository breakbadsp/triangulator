# Build guidelines

Triangulator requires Linux and GCC/libstdc++ 13 or later.
The code uses C++23 `std::expected`, `std::format`, and `std::byteswap`.
The AlmaLinux container test verified the normal build and static release on
AlmaLinux 9.8 and 10.2, on x86-64.
See [the test report](almalinux-user-test.md) for the evidence and test limits.

## Dependencies

- Checkout: Git.
- Build: GNU Make, a C++23 compiler, Bash, coreutils, diffutils, sed, static C/C++
  runtime libraries, and SQLite development headers and library.
- Release verification: binutils, including `readelf`.
- Tests: Python 3.11 or later and Node.js. No Python packages are required.
- Formatting: clang-format with the repository's `.clang-format` file.
- Fully static release: a static SQLite library, or `sqlite3.c` and `sqlite3.h`
  from the same SQLite amalgamation archive. This option also needs a C compiler.

`cmp` comes from diffutils. The Makefile uses it to compare saved build options.
An absent command or a comparison error stops the build.
The dashboard tests require Node.js. An absent Node.js executable fails the tests.
The optional eBPF kernel test is separate and remains disabled in normal checks.

## Install packages in AlmaLinux

Run these package commands as root inside the build container or build machine.
Compile and run Triangulator as an ordinary user.
The sampler and target process must run as the same user.
GitHub-hosted runners can create these containers without local Docker access
or `sudo` on your computer.

### AlmaLinux 9

The default GCC 11 compiler cannot build this project.
Install GCC Toolset 14 and select Node.js 22 from the module repository.
AlmaLinux includes [Node.js 22](https://wiki.almalinux.org/release-notes/9.6).

```sh
dnf install -y dnf-plugins-core git make diffutils coreutils sed binutils gcc-c++ sqlite-devel
dnf config-manager --set-enabled crb
dnf module enable -y nodejs:22
dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel glibc-static libstdc++-static python3.11 nodejs
```

CRB is the AlmaLinux repository that supplies the static development packages.
The compiler installation supplies a C compiler for the SQLite amalgamation.

### AlmaLinux 10

The default GCC 14 compiler supports the required language features.
Static runtime libraries still need a separate package installation.

```sh
dnf install -y dnf-plugins-core git make diffutils coreutils sed binutils gcc-c++ sqlite-devel
dnf config-manager --set-enabled crb
dnf install -y glibc-static libstdc++-static python3 nodejs
```

## Select the tools and build

1. Clone the project as an ordinary user.

   ```sh
   git clone https://github.com/breakbadsp/triangulator.git
   cd triangulator
   ```

2. On AlmaLinux 9, select GCC Toolset 14 and Python 3.11 for this shell.

   ```sh
   mkdir -p config/local/build-tools
   ln -sfn /usr/bin/python3.11 config/local/build-tools/python3
   export PATH="$PWD/config/local/build-tools:/opt/rh/gcc-toolset-14/root/usr/bin:$PATH"
   ```

   This local alias leaves the operating system's `python3` executable unchanged.
   AlmaLinux 10 needs no tool selection step.

3. Check the selected tool versions.

   ```sh
   c++ --version
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
See [configuration](../README.md#configuration) for separate hosts and custom paths.

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
For that setup:

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
See [production setup](../README.md#production-setup) for the service templates.

## Required quality checks

Keep the C++23 requirement, compiler warnings, `-Werror`, and static sampler linkage.
Keep the release dependency verification enabled.
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
- `missing cmp; install diffutils`: install diffutils.
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
