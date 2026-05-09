#!/bin/sh

for node in /usr/bin/node /usr/bin/nodejs /usr/bin/node-*; do
	if [ -x "$node" ]; then
		bin_dir=""
		if ! command -v node >/dev/null 2>&1; then
			bin_dir="$(mktemp -d)"
			ln -s "$node" "$bin_dir/node"
			PATH="$bin_dir:$PATH"
			export PATH
		fi
		if ! command -v npm >/dev/null 2>&1; then
			if [ -z "$bin_dir" ]; then
				bin_dir="$(mktemp -d)"
				PATH="$bin_dir:$PATH"
				export PATH
			fi
			for npm in /usr/bin/npm /usr/bin/npm-*; do
				if [ -x "$npm" ]; then
					ln -s "$npm" "$bin_dir/npm"
					break
				fi
			done
		fi
		exec "$node" /usr/share/local-npm-registry/dist/index.js "$@"
	fi
done

echo "local-npm-registry: node executable not found" >&2
exit 127
