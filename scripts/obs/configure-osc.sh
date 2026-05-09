#!/usr/bin/env bash

set -euo pipefail

OBS_APIURL="${OBS_APIURL:-https://api.opensuse.org}"

config_dir="${HOME}/.config/osc"
config_path="${config_dir}/oscrc"

mkdir -p "$config_dir"

: "${OBS_USERNAME:?OBS_USERNAME is required}"
: "${OBS_PASSWORD:?OBS_PASSWORD is required}"

obs_user="${OBS_USERNAME}"
obs_pass="${OBS_PASSWORD}"

cat >"$config_path" <<EOF
[general]
apiurl = ${OBS_APIURL}

[${OBS_APIURL}]
user = ${obs_user}
pass = ${obs_pass}
credentials_mgr_class = osc.credentials.PlaintextConfigFileCredentialsManager
EOF
chmod 600 "$config_path"

osc api /about >/dev/null
