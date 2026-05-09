#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT_TARBALL" >&2
  exit 1
fi

output_tarball="$1"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
payload_dir="${tmp_dir}/payload"

mkdir -p "${payload_dir}/.cargo"

(
  cd "$payload_dir"
  cargo vendor --locked --versioned-dirs --manifest-path "${repo_root}/src-tauri/Cargo.toml" vendor > .cargo/config.toml
)

mkdir -p "$(dirname "$output_tarball")"
tar -cJf "$output_tarball" -C "$payload_dir" .cargo vendor
