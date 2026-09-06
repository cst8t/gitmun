#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 PROJECT PACKAGE PROJECT_METADATA" >&2
  exit 1
fi

project="$1"
package="$2"
project_metadata="$3"
poll_seconds="${OBS_POLL_SECONDS:-60}"
timeout_seconds="${OBS_WAIT_TIMEOUT_SECONDS:-21600}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
results_file="$(mktemp)"
started_at="$SECONDS"
trap 'rm -f "$results_file"' EXIT

while true; do
  osc results --xml --no-multibuild "$project" "$package" >"$results_file"

  set +e
  python3 "${script_dir}/check-release-readiness.py" \
    "$project_metadata" "$results_file" "$package"
  readiness_status=$?
  set -e

  case "$readiness_status" in
    0)
      osc results --no-multibuild "$project" "$package"
      exit 0
      ;;
    1)
      osc results -v --no-multibuild "$project" "$package" || true
      exit 1
      ;;
    2)
      if ((SECONDS - started_at >= timeout_seconds)); then
        echo "Timed out after ${timeout_seconds}s waiting for OBS publication" >&2
        osc results -v --no-multibuild "$project" "$package" || true
        exit 1
      fi
      sleep "$poll_seconds"
      ;;
    *)
      echo "Unexpected OBS readiness status: ${readiness_status}" >&2
      exit 1
      ;;
  esac
done
