# Test a new installation in AlmaLinux

The `AlmaLinux new user test` workflow runs on GitHub-hosted Linux runners.
It does not need Docker access or `sudo` on your computer.
It tests the official `almalinux:9` and `almalinux:10` container images.

## Run the test

After the workflow is merged into `master`:

1. Open the repository's **Actions** page.
2. Select **AlmaLinux new user test**.
3. Select **Run workflow**.
4. Select the branch to test.
5. Start the workflow.
6. Download the artifacts from the completed run.

Each AlmaLinux version has a separate artifact. Artifacts expire after 14 days.
Changes to the workflow or its scripts start it on pull requests.
The initial test branch also starts it when these files change on push.

## What the test does

1. Save the image details and the initial package list.
2. Install Git and clone the checked-out commit inside the container.
3. Run `scripts/start.sh` before installing build dependencies.
4. Save the first startup error and exit status.
5. Try `make` with the distribution's default compiler.
6. Install the required compiler, static runtime libraries, and test tools.
7. Run the startup scripts as an ordinary user.
8. Monitor a `sleep` process owned by that user.
9. Change the target and sampling rate with the control scripts.
10. Check the dashboard and live API.
11. Run `make check`, including the Node.js dashboard tests.
12. Try `make release` without a static SQLite library.
13. Build the release with the verified SQLite 3.53.4 amalgamation.
14. Run `make check` with the same static build options.
15. Copy the release binaries into a second clean container.
16. Check monitoring and the dashboard as UID 1000 in that container.
17. Run the copied socket report helper.

Package installation uses root inside the disposable build container.
Compilation and normal operation use an ordinary user.
The second container installs no packages. It has no Linux capabilities.
The test saves both normal and release binaries, logs, exit statuses, and package
lists. The link reports show the shared-library dependencies of each build.

## Limits

An AlmaLinux container uses the GitHub runner's Linux kernel.
This test verifies the AlmaLinux user environment and its build dependencies.
It does not verify an AlmaLinux kernel, SELinux policy, or the systemd units.
The target process runs inside the same container as the sampler.

The optional eBPF source is outside this test. Its kernel test remains skipped.
It needs additional kernel features and permissions.
See [the socket source guide](socket-ingress-design.md#build-and-run).

## Problems found in the first test

The first run tested AlmaLinux 9.8 and 10.2 on x86-64.
Both normal builds and static builds passed the C++ tests and `make check`.
Each test run ran 51 Python tests: 50 passed and the optional eBPF test was skipped.
The Node.js dashboard tests ran and passed.
The copied static sampler and collector also returned live target samples and
the dashboard in the clean containers, as UID 1000 with no capabilities.
The first workflow run failed because its HTTP status check required HTTP/1.1.
The collector correctly returned HTTP/1.0. The workflow now checks the status
code without requiring a protocol version.

The installation problems were:

- The base images do not include Git or Make. The first startup stopped with
  `make: command not found` after it created the local configuration files.
- AlmaLinux 9's default GCC 11.5 cannot compile this project. The first build
  stopped with `fatal error: expected: No such file or directory`.
  GCC Toolset 14 supplied the required C++23 support.
- AlmaLinux 10's default GCC 14.3 supports the required language features.
  The first build still failed because the static C and C++ runtime libraries
  were absent: `cannot find -lstdc++`, `cannot find -lm`, and `cannot find -lc`.
- Both images lacked `cmp`, supplied by `diffutils`. The build continued after
  `cmp: command not found`, but it could not compare the saved build options.
  AlmaLinux 10 continued to show this error until `diffutils` was added explicitly.
- Neither setup had a static SQLite library. Plain `make release` stopped with
  `cannot find -lsqlite3`. The documented `SQLITE_SOURCE` option worked with the
  verified SQLite amalgamation.
- `triangulator-sampler --help` exited with status 2 and an invalid configuration
  error. The sampler treated `--help` as a configuration filename.

## Dependencies used by the test

The build needs Git, Make, GCC/libstdc++ 13 or later, `sqlite-devel`,
`glibc-static`, `libstdc++-static`, and `diffutils`.
The scripts also use Bash, coreutils, sed, and `getconf`.
The compiler installation supplies binutils, including `readelf`.
The test enables the AlmaLinux CRB repository for static development packages.

AlmaLinux 9 also needs `gcc-toolset-14-gcc-c++`,
`gcc-toolset-14-libstdc++-devel`, and Python 3.11 for the tests.
The test puts the toolset compiler and a Python 3.11 alias on `PATH`.
It does not replace the operating system's `python3`.
AlmaLinux 10 uses its default compiler and Python.

Node.js is needed to run the dashboard JavaScript tests. Without it, `make check`
skips those tests. Python is needed for tests and local target control.
It is not needed by the copied monitoring binaries.
The clean AlmaLinux images already contain Python, so the test records that fact;
it does not claim to use a Python-free image.

The normal sampler is fully static. The normal collector and socket report helper
still use shared SQLite and glibc libraries. The release binaries have no shared
library dependencies. The link reports record this distinction.

## Recommended improvements

1. Add AlmaLinux package commands to the main build instructions.
2. Check the compiler, static libraries, and required commands before building.
3. Report a missing `cmp` as a dependency error.
4. Put the fully static build instructions next to the binary deployment example.
5. Publish release archives with the binaries and usable local configuration files.
6. Document Node.js and any skipped tests in the test instructions.
7. Add consistent `--help` and version output to the programs.
