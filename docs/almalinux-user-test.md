# Test a new installation in AlmaLinux

The `AlmaLinux new user test` workflow runs on the
[self-hosted runner pool](self-hosted-runner.md) in rootless containers. Fork
pull requests use GitHub-hosted runners. You need no local Docker access or
`sudo` to run the workflow.
Pull requests run the normal build and test suite in a prepared
AlmaLinux 8 build image. The image reuses installed dependencies. Nightly and
full manual runs test both the normal and static-release builds in `almalinux:8` and `almalinux:9`. Manual runs can also test
`almalinux:10`.

## Run the test

The workflow starts on pull requests that change the workflow, its scripts,
build files, source files, configuration, tests, or workload fixtures.
Documentation alone does not start the container build. The QA results
workflow still checks QA summary changes.

For an updated PR, a small input check looks for a passing run for the same
PR. If build and test inputs match and the base branch has no untested code
changes, the format and container jobs are skipped. The log links to the
reused run. Test fixtures, including Markdown files under `tests/`, remain
inputs. Missing history or API access causes a full run. Manual and nightly
dispatches always run the tests. See [check reuse](loomflow.md#reuse-passing-checks).
T3 dispatches full nightly runs at 03:00 in `Asia/Kolkata` on the latest
`master` commit. GitHub cron triggers are disabled. The T3 host must be awake
and its scheduling service must be running. See
[nightly dispatch and monitoring](self-hosted-runner.md#nightly-dispatch-and-monitoring)
for hourly monitoring, duplicate prevention, and uncertain submissions.
AlmaLinux 10 runs only when selected for a manual run.
To start it by hand:

1. Open the repository's **Actions** page.
2. Select **AlmaLinux new user test**.
3. Select **Run workflow**.
4. Select the branch to test.
5. Select **Also test AlmaLinux 10** if needed. To measure PR CI instead,
   select **Run only the fast PR checks with the prepared image**. This option
   tests only AlmaLinux 8 and skips installation and static-release checks.
6. Start the workflow.
7. Download the artifacts from the completed run.

Each AlmaLinux version has a separate artifact. Artifacts expire after 14 days.

## What the test does

PR jobs use a prepared image and run steps 6–11. Nightly and full manual runs
use a clean base image and run all steps, including installation diagnostics.
Local jobs use persistent compiler caches outside the runner temporary
directory. Fork jobs restore a compiler cache from GitHub. The cache reuses
only compilations whose compiler, options, source, and included headers match.
Linking and test execution run when build or test inputs need verification. See the
[runner cache and image details](self-hosted-runner.md#the-runner-host).

1. Save the image details and the initial package list.
2. Install Git and clone the checked-out commit inside the container.
3. Run `scripts/start.sh` before installing build dependencies.
   It must stop with `required command not found` and create no local files.
4. Try `make` with the distribution's default compiler.
   On AlmaLinux 8 and 9, it must stop with `cannot compile C++23`.
5. Install the compiler, static runtime libraries, and test tools.
   The test does not install `diffutils` (`cmp`). It hides `cmp` if another
   package installs it. The test does not change `PATH` for the compiler.
   On AlmaLinux 8 and 9, it sets `CXX` to the GCC Toolset 14 compiler.
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
The nightly and manual runtime checks use a second container that installs no packages. It has no Linux capabilities.
The test saves normal binaries, logs, exit statuses, package lists, and
compiler-cache statistics. Nightly and manual runs also save release binaries. The link reports show the shared-library dependencies of each build.

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
The test enables PowerTools on AlmaLinux 8 and CRB on AlmaLinux 9 and 10
for static development packages.

AlmaLinux 8 and 9 also need `gcc-toolset-14-gcc-c++`,
`gcc-toolset-14-libstdc++-devel`, and Python 3.11 for the tests.
The test gives the toolset compiler to Make with `CXX`.
It puts a Python 3.11 alias on `PATH` and does not replace the operating
system's `python3`. AlmaLinux 10 uses its default compiler and Python.

Node.js is needed to run the dashboard JavaScript tests. Without it, `make check`
fails those tests. Python is needed for tests, local target control, and
`make sqlite-amalgamation`.
It is not needed by the copied monitoring binaries.
The clean AlmaLinux images already contain Python, so the test records that fact;
it does not claim to use a Python-free image.

The normal sampler is fully static. The normal collector and socket report helper
still use shared SQLite and glibc libraries. The release binaries have no shared
library dependencies. The link reports record this distinction.

## Build guidelines and fixes

The [build guidelines](build-guidelines.md) contain AlmaLinux package commands,
tool selection, static release instructions, and required quality checks.
Make compares saved build options without `cmp`.
The sampler now accepts `-h` and `--help` without reading a configuration file.
The dashboard tests now fail when Node.js is absent.
The AlmaLinux 8 and 9 tests select Node.js 22 explicitly.

## Remaining improvements

1. Define the oldest supported kernel and CPU architecture.
2. Verify releases on that kernel and the supported AlmaLinux service environment.
3. Publish release archives with binaries, local configuration files, and checksums.
4. Add a compiler and library diagnostic command if installation errors remain unclear.
5. Define release version information before adding version output to the programs.
