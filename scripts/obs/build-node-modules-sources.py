#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import struct
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModuleSource:
    package_name: str
    version: str
    url: str
    integrity: str | None
    filename: str


class CpioWriter:
    def __init__(self, output_path: Path) -> None:
        self._fh = output_path.open("wb")

    def close(self) -> None:
        self.add("TRAILER!!!", b"")
        self._fh.close()

    def add(self, name: str, content: bytes, perm: int = 0o644) -> None:
        encoded_name = name.encode("utf-8") + b"\0"
        mode = perm | 0x8000
        size = len(content)
        header = (
            b"070701%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%08x%s"
            % (0, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, len(encoded_name), 0, encoded_name)
        )

        self._fh.write(header)
        if len(header) % 4:
            self._fh.write(b"\0" * (4 - len(header) % 4))
        self._fh.write(content)
        if size % 4:
            self._fh.write(b"\0" * (4 - size % 4))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build OBS-style npm offline source inputs")
    parser.add_argument("lockfile", type=Path, help="Path to package-lock.json")
    parser.add_argument("output_cpio", type=Path, help="Path to node_modules.obscpio")
    parser.add_argument("output_spec", type=Path, help="Path to node_modules.spec.inc")
    return parser.parse_args()


def normalise_package_name(package_path: str, package_data: dict[str, object]) -> str:
    if package_path.startswith("node_modules/"):
        return package_path.rsplit("node_modules/", 1)[1]
    name = package_data.get("name")
    if isinstance(name, str) and name:
        return name
    raise ValueError(f"cannot determine package name for entry {package_path!r}")


def sanitise_filename(package_name: str, version: str, url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix or ".tgz"
    base = package_name.replace("/", "-")
    return f"{base}-{version}{suffix}"


def decode_integrity(value: str) -> list[tuple[str, bytes]]:
    entries: list[tuple[str, bytes]] = []
    for token in value.split():
        algorithm, digest = token.split("-", 1)
        padded = digest + ("=" * (-len(digest) % 4))
        entries.append((algorithm, base64.b64decode(padded)))
    return entries


def verify_integrity(module: ModuleSource, content: bytes) -> None:
    if not module.integrity:
        return

    for algorithm, expected_digest in decode_integrity(module.integrity):
        actual_digest = hashlib.new(algorithm, content).digest()
        if actual_digest == expected_digest:
            return

    raise ValueError(f"integrity mismatch for {module.url}")


def collect_sources(lockfile_data: dict[str, object]) -> list[ModuleSource]:
    packages = lockfile_data.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("package-lock.json does not contain a packages map")

    modules_by_url: dict[str, ModuleSource] = {}
    used_filenames: set[str] = set()

    for package_path, package_data in packages.items():
        if not isinstance(package_data, dict):
            continue

        resolved = package_data.get("resolved")
        version = package_data.get("version")
        if not isinstance(resolved, str) or not resolved.startswith(("http://", "https://")):
            continue
        if not isinstance(version, str) or not version:
            continue

        package_name = normalise_package_name(str(package_path), package_data)
        filename = sanitise_filename(package_name, version, resolved)
        integrity = package_data.get("integrity")
        integrity_value = integrity if isinstance(integrity, str) else None
        existing = modules_by_url.get(resolved)
        if existing is None:
            filename_root, filename_suffix = split_filename(filename)
            while filename in used_filenames:
                filename = f"{filename_root}-{hashlib.sha256(resolved.encode('utf-8')).hexdigest()[:12]}{filename_suffix}"
            used_filenames.add(filename)
            modules_by_url[resolved] = ModuleSource(package_name, version, resolved, integrity_value, filename)

    return sorted(modules_by_url.values(), key=lambda module: module.filename)


def split_filename(filename: str) -> tuple[str, str]:
    path = Path(filename)
    return path.stem, path.suffix or ".tgz"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        return response.read()


def write_spec(output_spec: Path, modules: list[ModuleSource]) -> None:
    lines = [f"Source:         {module.url}#/{module.filename}" for module in modules]
    output_spec.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_cpio(output_cpio: Path, modules: list[ModuleSource]) -> None:
    writer = CpioWriter(output_cpio)
    try:
        for module in modules:
            content = fetch(module.url)
            verify_integrity(module, content)
            writer.add(module.filename, content)
    finally:
        writer.close()


def main() -> int:
    args = parse_args()
    lockfile_data = json.loads(args.lockfile.read_text(encoding="utf-8"))
    modules = collect_sources(lockfile_data)

    args.output_cpio.parent.mkdir(parents=True, exist_ok=True)
    args.output_spec.parent.mkdir(parents=True, exist_ok=True)

    write_spec(args.output_spec, modules)
    write_cpio(args.output_cpio, modules)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
