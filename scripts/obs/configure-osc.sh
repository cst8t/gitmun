#!/usr/bin/env bash

set -euo pipefail

: "${OBS_APIURL:?OBS_APIURL is required}"

config_dir="${HOME}/.config/osc"
config_path="${config_dir}/oscrc"

mkdir -p "$config_dir"

if [[ -n "${OBS_TOKEN:-}" ]]; then
  obs_user=""
  obs_pass="${OBS_TOKEN}"
else
  : "${OBS_USERNAME:?OBS_USERNAME is required}"
  : "${OBS_PASSWORD:?OBS_PASSWORD is required}"
  obs_user="${OBS_USERNAME}"
  obs_pass="${OBS_PASSWORD}"
fi

cat >"$config_path" <<EOF
[general]
apiurl = ${OBS_APIURL}

[${OBS_APIURL}]
user = ${obs_user}
pass = ${obs_pass}
EOF
chmod 600 "$config_path"

osc api /about >/dev/null
