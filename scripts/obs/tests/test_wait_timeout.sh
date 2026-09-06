#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
obs_dir="$(cd "${script_dir}/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

cat >"${fake_bin}/osc" <<'EOF'
#!/usr/bin/env bash
if [[ " $* " == *" --xml "* ]]; then
  sed '0,/code="published" state="published"/s//code="building" state="building"/' "$OBS_TEST_RESULTS"
fi
EOF
chmod +x "${fake_bin}/osc"

set +e
output="$(
  PATH="${fake_bin}:${PATH}" \
    OBS_POLL_SECONDS=0 \
    OBS_WAIT_TIMEOUT_SECONDS=0 \
    OBS_TEST_RESULTS="${script_dir}/fixtures/results-published.xml" \
    bash "${obs_dir}/wait-for-release-publication.sh" \
    home:cst8t:gitmun gitmun "${script_dir}/fixtures/project.xml" 2>&1
)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected the publication wait to time out" >&2
  exit 1
fi

if [[ "$output" != *"Timed out after 0s waiting for OBS publication"* ]]; then
  echo "$output" >&2
  exit 1
fi
