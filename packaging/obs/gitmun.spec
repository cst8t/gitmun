Name:           gitmun
Version:        0.1.0
Release:        0
Summary:        Cross-platform Git client
License:        GPL-3.0-only
URL:            https://github.com/cst8t/gitmun
Source0:        %{name}-%{version}.tar.xz
Source1:        vendor.tar.xz
Source2:        package-lock.json
BuildRequires:  cargo
BuildRequires:  desktop-file-utils
BuildRequires:  hicolor-icon-theme
BuildRequires:  local-npm-registry
BuildRequires:  nodejs >= 20
BuildRequires:  npm
BuildRequires:  patchelf
BuildRequires:  python3
BuildRequires:  rust >= 1.85
BuildRequires:  pkgconfig(ayatana-appindicator3-0.1)
BuildRequires:  pkgconfig(gtk+-3.0)
BuildRequires:  pkgconfig(librsvg-2.0)
BuildRequires:  pkgconfig(openssl)
BuildRequires:  pkgconfig(webkit2gtk-4.1)
Requires:       git

%undefine __brp_mangle_shebangs

%description
Gitmun is a desktop Git client built with Tauri, Rust and React.

%prep
%autosetup -a1

%build
export CARGO_NET_OFFLINE=true
local-npm-registry %{_sourcedir} install --also=dev
npm run generate:icons
npm run tauri build -- --no-bundle --config '{"version":"%{version}","bundle":{"active":true}}'

%install
install -Dm0755 src-tauri/target/release/gitmun %{buildroot}%{_bindir}/gitmun
install -Dm0644 %{_sourcedir}/com.cst8t.gitmun.desktop %{buildroot}%{_datadir}/applications/com.cst8t.gitmun.desktop
install -Dm0644 src-tauri/icons/32x32.png %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/com.cst8t.gitmun.png
install -Dm0644 src-tauri/icons/64x64.png %{buildroot}%{_datadir}/icons/hicolor/64x64/apps/com.cst8t.gitmun.png
install -Dm0644 src-tauri/icons/128x128.png %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/com.cst8t.gitmun.png
install -Dm0644 src-tauri/icons/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/com.cst8t.gitmun.png
install -Dm0644 /dev/null %{buildroot}%{_datadir}/gitmun/system-managed

%check
desktop-file-validate %{buildroot}%{_datadir}/applications/com.cst8t.gitmun.desktop

%files
%license LICENSE
%doc README.md
%{_bindir}/gitmun
%{_datadir}/applications/com.cst8t.gitmun.desktop
%{_datadir}/icons/hicolor/32x32/apps/com.cst8t.gitmun.png
%{_datadir}/icons/hicolor/64x64/apps/com.cst8t.gitmun.png
%{_datadir}/icons/hicolor/128x128/apps/com.cst8t.gitmun.png
%{_datadir}/icons/hicolor/512x512/apps/com.cst8t.gitmun.png
%dir %{_datadir}/gitmun
%{_datadir}/gitmun/system-managed

%changelog
