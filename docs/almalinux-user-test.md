# Test a new installation in AlmaLinux

The `AlmaLinux new user test` workflow runs on GitHub-hosted Linux runners.
It does not need Docker access or `sudo` on your computer.
It tests the official `almalinux:9` and `almalinux:10` container images.

## Run the test

The workflow starts on pull requests that change the workflow, its scripts,
the `Makefile`, or the files in `scripts/`. To start it by hand:

1. Open the repository's **Actions** page.
2. Select **AlmaLinux new user test**.
3. Select **Run workflow**.
4. Select the branch to test.
5. Start the workflow.
6. Download the artifacts from the completed run.

Each AlmaLinux version has a separate artifact. Artifacts expire after 14 days.

## What the test does

1. Save the image details and the initial package list.
2. Install Git and clone the checked-out commit inside the container.
3. Run `scripts/start.sh` before installing build dependencies.
   It must stop with `required command not found` and create no local files.
4. Try `make` with the distribution's default compiler.
   On AlmaLinux 9, it must stop with `cannot compile C++23`.
5. Install the compiler, static runtime libraries, and test tools.
   The test does not install `diffutils` (`cmp`) and does not change `PATH`
   for the compiler. On AlmaLinux 9, it sets `CXX` to the GCC Toolset 14 compiler.
6. Run the startup scripts as an ordinary user.
7. Monitor a `sleep` process owned by that user.
8. Change the target and sampling rate with the control scripts.
9. Check the dashboard and live API.
10. Run `make check`, including the Node.js dashboard tests.
11. Check that `--help` works for the sampler and the socket report helper.
12. Try `make release` without a static SQLite library.
    It must stop with a message that names `make sqlite-amalgamation`.
13. Run `make sqlite-amalgamation` and build the release with the verified
    SQLite amalgamation.
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

## Dependencies used by the test

The build needs Git, Make 4.2 or later, GCC/libstdc++ 13 or later,
`sqlite-devel`, `glibc-static`, and `libstdc++-static`.
The scripts also use Bash, coreutils, sed, and `getconf`.
The compiler installation supplies binutils, including `readelf`.
The test enables the AlmaLinux CRB repository for static development packages.

AlmaLinux 9 also needs `gcc-toolset-14-gcc-c++`,
`gcc-toolset-14-libstdc++-devel`, and Python 3.11 for the tests.
The test gives the toolset compiler to Make with `CXX`.
It puts a Python 3.11 alias on `PATH` and does not replace the operating
system's `python3`. AlmaLinux 10 uses its default compiler and Python.

Node.js is needed to run the dashboard JavaScript tests. Without it, `make check`
skips those tests. Python is needed for tests, local target control, and
`make sqlite-amalgamation`. It is not needed by the copied monitoring binaries.
The clean AlmaLinux images already contain Python, so the test records that fact;
it does not claim to use a Python-free image.

The normal sampler is fully static. The normal collector and socket report helper
still use shared SQLite and glibc libraries. The release binaries have no shared
library dependencies. The link reports record this distinction.

## Remaining improvements

1. Put the fully static build instructions next to the binary deployment example.
2. Publish release archives with the binaries and usable local configuration files.
3. Add version output to the programs when the project has a version number.
