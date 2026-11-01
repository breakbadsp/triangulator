#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
asset_root="${HOME:?HOME must be set}/ai"
asset_url="https://github.com/breakbadsp/ai-assets.git"

fail() {
  printf 'AI setup failed: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null || fail 'Install Git, then run scripts/setup-ai.sh again.'
export GIT_TERMINAL_PROMPT=0

if [[ ! -e "$asset_root" && ! -L "$asset_root" ]]; then
  git clone --branch main --single-branch "$asset_url" "$asset_root" ||
    fail 'Cannot clone ai-assets. Check network access and Git credentials.'
else
  checkout_root="$(git -C "$asset_root" rev-parse --show-toplevel 2>/dev/null)" ||
    fail "$asset_root exists but is not an ai-assets checkout."
  [[ "$checkout_root" == "$(cd -- "$asset_root" && pwd -P)" ]] ||
    fail "$asset_root is not a repository root."
  origin="$(git -C "$asset_root" config --get remote.origin.url)" ||
    fail "$asset_root has no origin remote."
  case "$origin" in
    "$asset_url"|https://github.com/breakbadsp/ai-assets|git@github.com:breakbadsp/ai-assets.git|ssh://git@github.com/breakbadsp/ai-assets.git) ;;
    *) fail "$asset_root has an unexpected origin: $origin" ;;
  esac
  [[ "$(git -C "$asset_root" branch --show-current)" == main ]] ||
    fail "$asset_root must be on main. Preserve your work before switching branches."
  [[ -z "$(git -C "$asset_root" status --porcelain --untracked-files=no)" ]] ||
    fail "$asset_root has tracked local edits. Commit or stash them first."
  git -C "$asset_root" fetch --no-tags origin main ||
    fail 'Cannot confirm ai-assets freshness. Check network access and Git credentials.'
  git -C "$asset_root" merge-base --is-ancestor HEAD FETCH_HEAD ||
    fail "$asset_root has local commits or divergent history. Resolve it before setup."
  git -C "$asset_root" merge --ff-only FETCH_HEAD ||
    fail 'Cannot update ai-assets. Preserve local files and resolve the Git error above.'
fi

bash "$asset_root/install.sh" ||
  fail 'Shared installation failed. Resolve the error above and run setup again.'
bash "$asset_root/scripts/check-loomflow.sh" "$project_root" ||
  fail 'LoomFlow reference checks failed. Check ai-assets and the project adapter files.'
printf 'LoomFlow ready. ai-assets commit: %s\n' "$(git -C "$asset_root" rev-parse HEAD)"
