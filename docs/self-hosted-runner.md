# Self-hosted CI runner

The repository's GitHub Actions jobs run on the owner's Linux computer
instead of GitHub's runners. Pull requests from forks still run on GitHub's
`ubuntu-24.04` runners, so code from outside contributors never runs on the
owner's computer.

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
- It runs as a systemd user service, `actions-runner.service`, and starts at
  boot because lingering is enabled for `gha-runner`.
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

One runner runs one job at a time, so matrix jobs run one after another. If
the computer is off, jobs wait in the queue for up to 24 hours.

## Set up the runner

Run this once from a checkout, as a user who can run `gh` and `sudo`:

```sh
gh api -X POST repos/breakbadsp/triangulator/actions/runners/registration-token \
  --jq .token | sudo .github/scripts/self-hosted-runner-setup.sh
```

The script installs `podman`, `python-pipx`, `github-cli`, and the build
and test tools (`base-devel`, `sqlite`, `nodejs`, and `python`), creates
`gha-runner`, downloads a checksum-verified runner, registers it with the
`triangulator` label, and starts the service. The token expires after one
hour.

To apply a newer version of the script to a registered runner, rerun it
without a token. It keeps the registration and restarts the service, which
cancels any job that is running:

```sh
sudo .github/scripts/self-hosted-runner-setup.sh < /dev/null
```

## Operate the runner

```sh
sudo systemctl --user -M gha-runner@ status actions-runner   # state
sudo journalctl _SYSTEMD_USER_UNIT=actions-runner.service -f  # logs
sudo systemctl --user -M gha-runner@ restart actions-runner  # restart
```

To remove the runner, stop the service, then delete it on GitHub
(**Settings → Actions → Runners**) and remove the user:

```sh
sudo systemctl --user -M gha-runner@ disable --now actions-runner
sudo loginctl disable-linger gha-runner
sudo userdel --remove gha-runner
```

To return all jobs to GitHub, set each `runs-on` back to `ubuntu-24.04`.
