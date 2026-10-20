#!/usr/bin/env bash
# Set up a GitHub Actions runner for this repository on an Arch Linux host.
# The runner runs as its own unprivileged user, gha-runner, and gets
# containers from rootless Podman through a `docker` command. No job gets root.
#
# Run as root, with a registration token on standard input:
#   gh api -X POST repos/breakbadsp/triangulator/actions/runners/registration-token \
#     --jq .token | sudo .github/scripts/self-hosted-runner-setup.sh
# Once the runner is registered, rerun it with no token to update the host:
#   sudo .github/scripts/self-hosted-runner-setup.sh < /dev/null
# See docs/self-hosted-runner.md.
set -euo pipefail

repo_url=https://github.com/breakbadsp/triangulator
runner_user=gha-runner
runner_version=2.338.0
runner_sha256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32

[[ $EUID -eq 0 ]] || { echo "Run this script as root." >&2; exit 1; }
token=
read -r token || true

pacman -S --needed --noconfirm podman python-pipx github-cli

if ! id "$runner_user" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$runner_user"
fi
# Rootless Podman maps container users to these subordinate IDs.
grep -q "^$runner_user:" /etc/subuid || usermod --add-subuids 200000-265535 "$runner_user"
grep -q "^$runner_user:" /etc/subgid || usermod --add-subgids 200000-265535 "$runner_user"
# Keep the user's systemd instance, and so the runner, running without a login.
loginctl enable-linger "$runner_user"

home=$(getent passwd "$runner_user" | cut -d: -f6)
uid=$(id -u "$runner_user")
as_runner() {
    runuser -u "$runner_user" -- env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" "$@"
}

as_runner bash -s "$runner_version" "$runner_sha256" <<'EOF'
set -euo pipefail
version=$1
sha256=$2
cd "$HOME"

# Jobs call `docker`; rootless Podman answers. Bare names like almalinux:9
# resolve to Docker Hub, as they do for Docker.
mkdir -p bin .config/containers
printf '#!/bin/sh\nexec podman "$@"\n' > bin/docker
chmod 755 bin/docker
cat > .config/containers/registries.conf <<'CONF'
unqualified-search-registries = ["docker.io"]
short-name-mode = "permissive"
CONF

if [[ ! -x actions-runner/run.sh ]]; then
    tarball=actions-runner-linux-x64-$version.tar.gz
    curl -fsSLo "$tarball" "https://github.com/actions/runner/releases/download/v$version/$tarball"
    echo "$sha256  $tarball" | sha256sum -c -
    mkdir -p actions-runner
    tar -xzf "$tarball" -C actions-runner
    rm "$tarball"
fi
EOF

if [[ ! -f "$home/actions-runner/.runner" ]]; then
    [[ -n "$token" ]] || { echo "Pass a registration token on standard input." >&2; exit 1; }
    as_runner "$home/actions-runner/config.sh" --unattended \
        --url "$repo_url" --token "$token" \
        --name "$(hostnamectl hostname)" --labels triangulator \
        --work _work --replace
fi
as_runner mkdir -p "$home/.config/systemd/user"
cat > "$home/.config/systemd/user/actions-runner.service" <<EOF
[Unit]
Description=GitHub Actions runner for triangulator
After=network-online.target

[Service]
WorkingDirectory=$home/actions-runner
# Jobs inherit this PATH, so `docker` finds the Podman wrapper first.
Environment=PATH=$home/bin:/usr/local/bin:/usr/bin
# Make run.sh pass SIGINT on to the runner, which then cancels any running
# job and exits. Whatever is left after a minute is killed.
Environment=RUNNER_MANUALLY_TRAP_SIG=1
ExecStart=$home/actions-runner/run.sh
Restart=always
RestartSec=10
KillMode=mixed
KillSignal=SIGINT
TimeoutStopSec=1min

[Install]
WantedBy=default.target
EOF
chown "$runner_user:" "$home/.config/systemd/user/actions-runner.service"
systemctl --user -M "$runner_user@" daemon-reload
systemctl --user -M "$runner_user@" enable actions-runner.service
systemctl --user -M "$runner_user@" restart actions-runner.service
systemctl --user -M "$runner_user@" --no-pager status actions-runner.service
