#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 LOCAL_NPM_REGISTRY_TARBALL" >&2
  exit 1
fi

source_tarball="$1"
project="${OBS_PROJECT:-home:cst8t:gitmun}"
package="${OBS_PACKAGE:-local-npm-registry}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
template_dir="${repo_root}/packaging/obs"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
checkout_dir="${tmp_dir}/checkout"

if [ ! -f "$source_tarball" ]; then
  echo "missing source tarball: $source_tarball" >&2
  exit 1
fi

osc checkout --output-dir "$checkout_dir" "$project" "$package"

find "$checkout_dir" -maxdepth 1 -type f -name 'local_npm_registry-v*.tar.gz' -delete

cp "${template_dir}/local-npm-registry.spec" "$checkout_dir"/local-npm-registry.spec
cp "${template_dir}/local-npm-registry.dsc" "$checkout_dir"/local-npm-registry.dsc
cp "${template_dir}/local-npm-registry.control" "$checkout_dir"/debian.control
cp "${template_dir}/local-npm-registry.rules" "$checkout_dir"/debian.rules
cp "${template_dir}/local-npm-registry.changelog" "$checkout_dir"/debian.changelog
cp "${template_dir}/local-npm-registry.sh" "$checkout_dir"/local-npm-registry.sh
cp "$source_tarball" "$checkout_dir"/

(
  cd "$checkout_dir"
  osc addremove
  osc commit -m "Update local-npm-registry helper package"
)
