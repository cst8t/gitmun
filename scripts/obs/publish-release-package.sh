#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 VERSION INPUT_DIR" >&2
  exit 1
fi

version="$1"
input_dir="$2"
project="${OBS_PROJECT:-home:cst8t:gitmun}"
package="${OBS_PACKAGE:-gitmun}"
deb_repository="${OBS_DEB_REPOSITORY:-xUbuntu_26.04}"
deb_arch="${OBS_DEB_ARCH:-x86_64}"
obs_poll_seconds="${OBS_POLL_SECONDS:-60}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

release_root="gitmun-${version}"
source_tarball="${tmp_dir}/${release_root}.tar.xz"
render_dir="${tmp_dir}/rendered"
checkout_dir="${tmp_dir}/checkout"

read_obs_build_code() {
  local results_file="$1"

  OBS_PACKAGE_NAME="$package" python3 - "$results_file" <<'PY'
import os
import sys
import xml.etree.ElementTree as ET

package = os.environ["OBS_PACKAGE_NAME"]
root = ET.parse(sys.argv[1]).getroot()

for result in root.findall("result"):
    result_dirty = result.get("dirty") is not None
    result_code = result.get("code") or "unknown"
    for status in result.findall("status"):
        if status.get("package") == package:
            print("dirty" if result_dirty else status.get("code", result_code))
            raise SystemExit(0)

print("missing")
raise SystemExit(2)
PY
}

wait_for_obs_build() {
  local repository="$1"
  local arch="$2"
  local results_file="${tmp_dir}/obs-results.xml"
  local build_code

  echo "Waiting for OBS build: ${project}/${package} ${repository} ${arch}"

  while true; do
    osc results --xml --no-multibuild -r "$repository" -a "$arch" "$project" "$package" >"$results_file"
    if ! build_code="$(read_obs_build_code "$results_file")"; then
      build_code="${build_code:-missing}"
    fi
    echo "OBS build status for ${repository}/${arch}: ${build_code}"

    case "$build_code" in
      succeeded)
        osc results --no-multibuild -r "$repository" -a "$arch" "$project" "$package"
        return 0
        ;;
      failed|broken|unresolvable|missing)
        osc results -v --no-multibuild -r "$repository" -a "$arch" "$project" "$package" || true
        return 1
        ;;
      blocked|scheduled|dispatching|building|signing|finished|dirty|unknown)
        sleep "$obs_poll_seconds"
        ;;
      *)
        echo "Unexpected OBS build status for ${repository}/${arch}: ${build_code}" >&2
        osc results -v --no-multibuild -r "$repository" -a "$arch" "$project" "$package" || true
        return 1
        ;;
    esac
  done
}

for required_file in vendor.tar.xz node_modules.obscpio node_modules.spec.inc package-lock.json ATTRIBUTIONS.html commit-hash.txt; do
  if [ ! -f "${input_dir}/${required_file}" ]; then
    echo "missing required input: ${input_dir}/${required_file}" >&2
    exit 1
  fi
done

mkdir -p "$render_dir"

git -C "$repo_root" archive --format=tar --prefix="${release_root}/" HEAD | xz -T0 >"$source_tarball"

tar -xJf "$source_tarball" -C "$tmp_dir"
cp "${input_dir}/ATTRIBUTIONS.html" "${tmp_dir}/${release_root}/public/"
cp "${input_dir}/commit-hash.txt" "${tmp_dir}/${release_root}/"
rm "$source_tarball"
tar -cJf "$source_tarball" -C "$tmp_dir" "$release_root"

cp -a "${repo_root}/packaging/obs/." "$render_dir/"

python3 - "$render_dir" "$version" <<'PY'
import pathlib
import re
import sys
from datetime import datetime, timezone

render_dir = pathlib.Path(sys.argv[1])
version = sys.argv[2]

spec_path = render_dir / "gitmun.spec"
spec_text = spec_path.read_text(encoding="utf-8")
spec_text = re.sub(r"^Version:\s+.*$", f"Version:        {version}", spec_text, count=1, flags=re.MULTILINE)
spec_path.write_text(spec_text, encoding="utf-8")

dsc_path = render_dir / "gitmun.dsc"
dsc_text = dsc_path.read_text(encoding="utf-8")
dsc_text = re.sub(r"^Version:\s+.*$", f"Version: {version}-1", dsc_text, count=1, flags=re.MULTILINE)
dsc_text = re.sub(r"^DEBTRANSFORM-TAR:\s+.*$", f"DEBTRANSFORM-TAR: gitmun-{version}.tar.xz", dsc_text, count=1, flags=re.MULTILINE)
dsc_path.write_text(dsc_text, encoding="utf-8")

changelog_path = render_dir / "debian.changelog"
changelog_text = changelog_path.read_text(encoding="utf-8").splitlines()
if len(changelog_text) < 3:
    raise SystemExit("debian.changelog is shorter than expected")
changelog_text[0] = f"gitmun ({version}-1) unstable; urgency=medium"
stamp = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
changelog_text[-1] = f" -- cst8t <cst8t@users.noreply.github.com>  {stamp}"
changelog_path.write_text("\n".join(changelog_text) + "\n", encoding="utf-8")
PY

osc checkout --output-dir "$checkout_dir" "$project" "$package"

find "$checkout_dir" -maxdepth 1 -type f -name 'gitmun-*.tar.xz' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'vendor.tar.*' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'node_modules.obscpio' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'node_modules.spec.inc' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'package-lock.json' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'ATTRIBUTIONS.html' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'commit-hash.txt' -delete
find "$checkout_dir" -maxdepth 1 -type f -name 'appimage.yml' -delete

cp "$render_dir"/_service "$checkout_dir"/
cp "$render_dir"/appimage.yml "$checkout_dir"/
cp "$render_dir"/gitmun.spec "$checkout_dir"/
cp "$render_dir"/gitmun.dsc "$checkout_dir"/
cp "$render_dir"/debian.changelog "$checkout_dir"/
cp "$render_dir"/debian.control "$checkout_dir"/
cp "$render_dir"/debian.rules "$checkout_dir"/
cp "$render_dir"/com.cst8t.gitmun.desktop "$checkout_dir"/
cp "$source_tarball" "$checkout_dir"/
cp "${input_dir}/vendor.tar.xz" "$checkout_dir"/
cp "${input_dir}/node_modules.obscpio" "$checkout_dir"/
cp "${input_dir}/node_modules.spec.inc" "$checkout_dir"/
cp "${input_dir}/package-lock.json" "$checkout_dir"/
cp "${input_dir}/ATTRIBUTIONS.html" "$checkout_dir"/
cp "${input_dir}/commit-hash.txt" "$checkout_dir"/

(
  cd "$checkout_dir"
  osc addremove
  osc commit --skip-local-service-run -m "Prepare OBS sources for ${version}"
)

osc rebuild "$project" "$package" "$deb_repository" "$deb_arch"
wait_for_obs_build "$deb_repository" "$deb_arch"
