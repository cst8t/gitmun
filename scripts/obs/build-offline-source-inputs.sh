#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT_DIR" >&2
  exit 1
fi

output_dir="$1"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

mkdir -p "$output_dir"

bash "${repo_root}/scripts/obs/build-cargo-vendor-tarball.sh" "${output_dir}/vendor.tar.xz"
python3 "${repo_root}/scripts/obs/build-node-modules-sources.py" \
  "${repo_root}/package-lock.json" \
  "${output_dir}/node_modules.obscpio" \
  "${output_dir}/node_modules.spec.inc"
cp "${repo_root}/package-lock.json" "${output_dir}/package-lock.json"
