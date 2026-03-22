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
PKGVER="$(printf '%s' "${DEB_NAME}" | sed -E "s/^${PKGNAME}_([^_]+)_.+\.deb$/\1/")"
if [[ -z "${PKGVER}" || "${PKGVER}" == "${DEB_NAME}" ]]; then
  PKGVER="$(jq -r '.version' "${TAURI_CONF}")"
fi
SHA256="$(sha256sum "${DEB_FILE}" | awk '{print $1}')"
INSTALL_FILE="${PKGNAME}.install"
REPO_SLUG="${REPO_SLUG:-${GITHUB_REPOSITORY:-${FORGEJO_REPOSITORY:-}}}"
if [[ -z "${REPO_SLUG}" ]]; then
  REPO_SLUG="$(git -C "${ROOT_DIR}" remote get-url origin | sed -E 's#^https?://[^/]+/([^/]+/[^/.]+)(\.git)?$#\1#')"
fi
if [[ -z "${REPO_SLUG}" ]]; then
  REPO_SLUG="owner/repo"
fi

SERVER_URL="${SERVER_URL:-${GITHUB_SERVER_URL:-${FORGEJO_SERVER_URL:-https://github.com}}}"
SERVER_URL="${SERVER_URL%/}"
PROJECT_URL="${SERVER_URL}/${REPO_SLUG}"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-${PROJECT_URL}/releases/download}"

cat > "${AUR_DIR}/PKGBUILD" <<EOF
pkgname=${PKGNAME}
pkgver=${PKGVER}
pkgrel=1
pkgdesc="A cross-platform Git GUI built with Tauri"
arch=('x86_64')
url="${PROJECT_URL}"
license=('GPL3')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1')
options=('!strip' '!debug' '!emptydirs')
install=${INSTALL_FILE}

source_x86_64=("${RELEASE_BASE_URL}/v\${pkgver}/${DEB_NAME}")
sha256sums_x86_64=('${SHA256}')

package() {
  cd "\${srcdir}"
  ar x "${DEB_NAME}"
  local data_tar
  data_tar=""
  for candidate in data.tar.zst data.tar.xz data.tar.gz data.tar.bz2; do
    if [[ -f "\${candidate}" ]]; then
      data_tar="\${candidate}"
      break
    fi
  done

  if [[ -z "\${data_tar}" ]]; then
    echo "No data.tar.* payload found in ${DEB_NAME}" >&2
    return 1
  fi

  bsdtar -xf "\${data_tar}" -C "\${pkgdir}"
}
EOF

cat > "${AUR_DIR}/.SRCINFO" <<EOF
pkgbase = ${PKGNAME}
  pkgdesc = A cross-platform Git GUI built with Tauri
  pkgver = ${PKGVER}
  pkgrel = 1
  url = ${PROJECT_URL}
  arch = x86_64
  license = GPL3
  depends = cairo
  depends = desktop-file-utils
  depends = gdk-pixbuf2
  depends = glib2
  depends = gtk3
  depends = hicolor-icon-theme
  depends = libsoup
  depends = pango
  depends = webkit2gtk-4.1
  source_x86_64 = ${RELEASE_BASE_URL}/v${PKGVER}/${DEB_NAME}
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

echo "Generated AUR files in ${AUR_DIR}"
