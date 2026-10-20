# Self-hosted CI runner

The repository's GitHub Actions jobs run on the owner's Linux computer
instead of GitHub's runners. Pull requests from forks still run on GitHub's
`ubuntu-24.04` runners, so code from outside contributors never runs on the
owner's computer.

## When jobs run

Pull requests run the format check and AlmaLinux 8 tests when their path
filters match. The QA results check keeps its existing path filters.
Sanitizers, AlmaLinux 8 and 9 tests, and packaging run nightly at midnight
in `Asia/Kolkata`. These workflows also support manual runs. Packaging
still builds and publishes releases for `v*` tags; nightly runs only
upload test artifacts.

## How jobs choose a runner

Each job has this line:

```yaml
runs-on: ${{ github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || 'self-hosted' }}
```

Pushes, tags, manual runs, and pull requests from branches in this
repository go to the self-hosted runner. Fork pull requests go to GitHub.

A fork can edit this line in its own pull request. The repository therefore
also requires the owner's approval before any workflow runs for an outside
contributor (**Settings → Actions → General → Approval for running fork pull
request workflows from contributors → Require approval for all external
contributors**). Read the workflow changes in a fork pull request before you
approve its run.

Jobs check `runner.environment` where the two runners differ. On the
self-hosted runner, the sanitizer job uses the installed `g++` instead of
installing `g++-14`, and skips the `vm.mmap_rnd_bits` change because the
host kernel already uses 28 bits.

## The runner host

The runner is set up for Arch Linux (Omarchy). It has these properties:

- It runs as `gha-runner`, a user with no `sudo` and no access to other
  users' home directories.
- Each runner slot has a systemd user service. Slot 1 uses
  `actions-runner.service`; slots 2 and 3 use `actions-runner-2.service` and
  `actions-runner-3.service`. Lingering starts them at boot.
- Jobs call `docker`, which runs rootless Podman. A container has no more
  rights than `gha-runner`.
- The host provides `g++`, `make`, `sqlite`, `nodejs`, `python3`, `pipx`,
  and `gh`.

Rootless containers own files under subordinate user IDs. The AlmaLinux job
therefore gives its `reports/` files back to `gha-runner` at the end, so the
next checkout can delete them. If the job stops before that step, for
example because the computer shut down or the service restarted, every later
checkout fails with a permission error in `reports/`. Remove the directory as
`gha-runner`:

```sh
sudo -iu gha-runner podman unshare rm -rf actions-runner/_work/triangulator/triangulator/reports
```

Each runner slot runs one job at a time. Setup creates one slot per two
CPUs, with a minimum of one and a maximum of three. The six-CPU Omarchy
host gets three slots. Each slot has a separate runner installation and
`_work` directory: `actions-runner`, `actions-runner-2`, and `actions-runner-3`.
All slots use the existing `triangulator` label. GitHub can assign jobs to
any free slot. See [GitHub runner routing](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow).

Builds use two compiler jobs per slot. The service sets `MAKEFLAGS=-j2`
for commands that do not specify `-j`. The AlmaLinux startup check also sets
this limit inside its container. Thus three build jobs can use the six CPUs
without each build starting six compilers. The slots share the rootless
Podman image store, but each container has its own network and filesystem.

The example tests select free UDP and HTTP ports for each test. The scenario
and capture scripts accept `BUGGY_UDP_PORT` and `BUGGY_HTTP_PORT`, so concurrent
host test runs do not use the same ports. Their defaults remain 9500 and 9501.

The release workflow builds AlmaLinux 8 and 9 in separate matrix jobs.
Each job tests both packages and uploads `packages-el8` or `packages-el9`.
For a version tag, a publication job waits for both builds, downloads both
artifacts, and creates one release.

If the computer is off, jobs wait in the queue for up to 24 hours.

## Set up the runner

Run this once from a checkout, as a user who can run `gh` and `sudo`:

```sh
gh api -X POST repos/breakbadsp/triangulator/actions/runners/registration-token \
  --jq .token | sudo .github/scripts/self-hosted-runner-setup.sh
```

To choose a different slot count, pass `RUNNER_COUNT` to the root command:

```sh
gh api -X POST repos/breakbadsp/triangulator/actions/runners/registration-token \
  --jq .token | sudo env RUNNER_COUNT=3 .github/scripts/self-hosted-runner-setup.sh
```

The script installs `podman`, `python-pipx`, `github-cli`, and the build
and test tools (`base-devel`, `sqlite`, `nodejs`, and `python`), creates
`gha-runner`, downloads a checksum-verified runner, registers it with the
`triangulator` label, and starts each service. It downloads and verifies the
runner archive once for all new slots. The token expires after one hour.

To add slots to an existing host, run the registration command again. Setup
keeps existing registrations and starts the new services. It does not
restart active services or cancel their jobs.

When all requested slots are registered, update setup without a token:

```sh
sudo .github/scripts/self-hosted-runner-setup.sh < /dev/null
```

Service changes take effect at the next restart. Restart a slot when it is
idle to apply them. An explicit restart cancels a job on that slot.

A lower `RUNNER_COUNT` does not stop or remove existing slots. To reduce the
pool, disable each extra service and remove its registration on GitHub.

## Operate the runner

```sh
sudo systemctl --user -M gha-runner@ status actions-runner   # state
sudo journalctl _SYSTEMD_USER_UNIT=actions-runner.service -f  # logs
sudo systemctl --user -M gha-runner@ restart actions-runner  # restart slot 1
sudo systemctl --user -M gha-runner@ status 'actions-runner*' # all slots
sudo systemctl --user -M gha-runner@ restart actions-runner-2 # restart slot 2
```

To remove the pool, stop all services, then delete all its runners on GitHub
(**Settings → Actions → Runners**) and remove the user:

```sh
sudo systemctl --user -M gha-runner@ disable --now actions-runner.service actions-runner-2.service actions-runner-3.service
sudo loginctl disable-linger gha-runner
sudo userdel --remove gha-runner
```

To return all jobs to GitHub, set each `runs-on` back to `ubuntu-24.04`.
