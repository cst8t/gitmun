Name:           local-npm-registry
Version:        1.1.0
Release:        0
Summary:        Localhost-only version of npm registry
License:        GPL-3.0-or-later
URL:            https://github.com/openSUSE/npm-localhost-proxy
Source0:        local_npm_registry-v%{version}.tar.gz
Source1:        local-npm-registry.sh
Requires:       nodejs
BuildArch:      noarch

%description
localhost-only npm registry serves npm packages on a localhost address so npm
install can run in a non-networked environment.

%prep
%autosetup -p1 -n local_npm_registry-v%{version}

%build
# nothing to build

%install
install -d %{buildroot}%{_bindir}
install -d %{buildroot}%{_datadir}/%{name}
cp -a dist node_modules %{buildroot}%{_datadir}/%{name}/
install -Dm0755 %{SOURCE1} %{buildroot}%{_bindir}/local-npm-registry

%files
%license COPYING
%doc README.md
%{_bindir}/local-npm-registry
%{_datadir}/%{name}

%changelog
