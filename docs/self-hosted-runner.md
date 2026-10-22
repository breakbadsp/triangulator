# CI host decisions

- Keep fork jobs on GitHub-hosted runners. Outside code must not run on the owner's computer.
- Use `gha-runner` without sudo and use rootless Podman. A build container must have no more host rights than that account.
- Use separate runner work directories so concurrent jobs cannot overwrite checkout state.
- Limit compiler parallelism across slots to avoid CPU contention.
- Keep compiler caches outside job temporary directories. Do not change shared cache ownership while another job can use it.
- Keep package caches separate because package containers build as root.
- Use prepared images for PR speed. Nightly and full manual runs test dependency installation from a clean container.
- Keep nightly dispatch state outside checkouts. The dispatcher must not repeat work after a checkout changes.
- The T3 host must be awake at dispatch time, with authenticated `gh` and available runner services. A missed schedule needs a later dispatch that day.
- Rootless containers can leave files owned by subordinate IDs after interruption. Remove affected job-owned output through `podman unshare` as `gha-runner` before the next checkout.
- Setup and operation: [runner setup](../.github/scripts/self-hosted-runner-setup.sh), [nightly dispatcher](../.github/scripts/dispatch-nightly.py), [workflows](../.github/workflows/).
