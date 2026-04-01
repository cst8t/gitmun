#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUR_DIR="${ROOT_DIR}/packaging/aur"
TAURI_CONF="${ROOT_DIR}/src-tauri/tauri.conf.json"

mkdir -p "${AUR_DIR}"

shopt -s nullglob
DEB_FILES=("${ROOT_DIR}"/src-tauri/target/release/bundle/deb/*.deb)
if [[ ${#DEB_FILES[@]} -eq 0 ]]; then
  echo "No .deb bundle found. Build deb first (tauri build --bundles deb) before generating AUR files." >&2
  exit 1
fi
DEB_FILE="${DEB_FILES[0]}"
DEB_NAME="$(basename "${DEB_FILE}")"
PKGNAME="$(jq -r '.productName' "${TAURI_CONF}" | tr '[:upper:]' '[:lower:]')"
PKGVER_RAW="$(printf '%s' "${DEB_NAME}" | sed -E "s/^${PKGNAME}_([^_]+)_.+\.deb$/\1/")"
if [[ -z "${PKGVER_RAW}" || "${PKGVER_RAW}" == "${DEB_NAME}" ]]; then
  PKGVER_RAW="$(jq -r '.version' "${TAURI_CONF}")"
fi
PKGVER="$(printf '%s' "${PKGVER_RAW}" | sed -E 's/[^[:alnum:]._+]+/_/g')"
SHA256="$(sha256sum "${DEB_FILE}" | awk '{print $1}')"
INSTALL_FILE="${PKGNAME}.install"
UPSTREAM_LICENSE_FILE="LICENSE.${PKGNAME}"
UPSTREAM_LICENSE_SHA256="$(sha256sum "${ROOT_DIR}/LICENSE" | awk '{print $1}')"
REPO_SLUG="${REPO_SLUG:-${GITHUB_REPOSITORY:-${FORGEJO_REPOSITORY:-}}}"
if [[ -z "${REPO_SLUG}" ]]; then
  REMOTE_URL="$(git -C "${ROOT_DIR}" remote get-url origin)"
  REPO_SLUG="$(printf '%s' "${REMOTE_URL}" | sed -E \
    -e 's#^https?://[^/]+/([^/]+/[^/.]+)(\.git)?$#\1#' \
    -e 's#^ssh://git@[^/]+/([^/]+/[^/.]+)(\.git)?$#\1#' \
    -e 's#^git@[^:]+:([^/]+/[^/.]+)(\.git)?$#\1#')"
fi
if [[ -z "${REPO_SLUG}" ]]; then
  REPO_SLUG="owner/repo"
fi

SERVER_URL="${SERVER_URL:-${GITHUB_SERVER_URL:-${FORGEJO_SERVER_URL:-https://github.com}}}"
SERVER_URL="${SERVER_URL%/}"
PROJECT_URL="${SERVER_URL}/${REPO_SLUG}"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-${PROJECT_URL}/releases/download}"
RELEASE_TAG="${RELEASE_TAG:-v${PKGVER_RAW}}"

cat > "${AUR_DIR}/PKGBUILD" <<EOF
pkgname=${PKGNAME}
pkgver=${PKGVER}
pkgrel=1
pkgdesc="A cross-platform Git GUI built with Tauri"
arch=('x86_64')
url="${PROJECT_URL}"
license=('GPL-3.0-only')
depends=(
  'cairo'
  'desktop-file-utils'
  'gdk-pixbuf2'
  'git'
  'glib2'
  'gtk-update-icon-cache'
  'gtk3'
  'hicolor-icon-theme'
  'libsoup3'
  'pango'
  'webkit2gtk-4.1'
)
options=('!strip' '!debug' '!emptydirs')
install=${INSTALL_FILE}

source=("${UPSTREAM_LICENSE_FILE}")
source_x86_64=("${RELEASE_BASE_URL}/${RELEASE_TAG}/${DEB_NAME}")
sha256sums=('${UPSTREAM_LICENSE_SHA256}')
sha256sums_x86_64=('${SHA256}')

package() {
  cd "\${srcdir}"
  ar x "${DEB_NAME}"
  local _data_tar
  _data_tar=""
  for _candidate in data.tar.zst data.tar.xz data.tar.gz data.tar.bz2; do
    if [[ -f "\${_candidate}" ]]; then
      _data_tar="\${_candidate}"
      break
    fi
  done

  if [[ -z "\${_data_tar}" ]]; then
    echo "No data.tar.* payload found in ${DEB_NAME}" >&2
    return 1
  fi

  bsdtar -xf "\${_data_tar}" -C "\${pkgdir}"
  install -Dm644 /dev/null "\${pkgdir}/usr/share/gitmun/system-managed"
  install -Dm644 "${UPSTREAM_LICENSE_FILE}" "\${pkgdir}/usr/share/licenses/\${pkgname}/LICENSE"
}
EOF

cat > "${AUR_DIR}/.SRCINFO" <<EOF
pkgbase = ${PKGNAME}
  pkgdesc = A cross-platform Git GUI built with Tauri
  pkgver = ${PKGVER}
  pkgrel = 1
  url = ${PROJECT_URL}
  install = ${INSTALL_FILE}
  arch = x86_64
  license = GPL-3.0-only
  depends = cairo
  depends = desktop-file-utils
  depends = gdk-pixbuf2
  depends = git
  depends = glib2
  depends = gtk-update-icon-cache
  depends = gtk3
  depends = hicolor-icon-theme
  depends = libsoup3
  depends = pango
  depends = webkit2gtk-4.1
  source = ${UPSTREAM_LICENSE_FILE}
  source_x86_64 = ${RELEASE_BASE_URL}/${RELEASE_TAG}/${DEB_NAME}
  sha256sums = ${UPSTREAM_LICENSE_SHA256}
  sha256sums_x86_64 = ${SHA256}

pkgname = ${PKGNAME}
EOF

cat > "${AUR_DIR}/${INSTALL_FILE}" <<'EOF'
post_install() {
  gtk-update-icon-cache -q -t -f usr/share/icons/hicolor || true
  update-desktop-database -q || true
}

post_upgrade() {
  post_install
}

post_remove() {
  gtk-update-icon-cache -q -t -f usr/share/icons/hicolor || true
  update-desktop-database -q || true
}
EOF

cp "${ROOT_DIR}/LICENSE" "${AUR_DIR}/${UPSTREAM_LICENSE_FILE}"

cat > "${AUR_DIR}/LICENSE" <<'EOF'
Copyright Arch Linux Contributors

Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
EOF

cat > "${AUR_DIR}/REUSE.toml" <<EOF
version = 1

[[annotations]]
path = [
    "PKGBUILD",
    ".SRCINFO",
    "${INSTALL_FILE}",
]
SPDX-FileCopyrightText = "Arch Linux contributors"
SPDX-License-Identifier = "0BSD"

[[annotations]]
path = "${UPSTREAM_LICENSE_FILE}"
SPDX-FileCopyrightText = "cst8t"
SPDX-License-Identifier = "GPL-3.0-only"
EOF

echo "Generated AUR files in ${AUR_DIR}"
