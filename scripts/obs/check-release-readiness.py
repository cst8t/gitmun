#!/usr/bin/env python3

import argparse
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass


class InvalidObsDataError(Exception):
    pass


class ObsReleaseFailedError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    repository: str
    architecture: str


@dataclass(frozen=True)
class Result:
    code: str
    state: str | None
    dirty: bool
    package_code: str | None


def read_targets(project_metadata: str) -> set[Target]:
    root = ET.fromstring(project_metadata)
    targets: set[Target] = set()

    for repository in root.findall("repository"):
        name = repository.get("name")
        if not name:
            raise InvalidObsDataError(
                "OBS project metadata contains a repository without a name"
            )

        for architecture in repository.findall("arch"):
            if not architecture.text or not architecture.text.strip():
                raise InvalidObsDataError(
                    f"OBS repository {name} contains an empty architecture"
                )
            target = Target(name, architecture.text.strip())
            if target in targets:
                raise InvalidObsDataError(
                    f"OBS project metadata contains duplicate target {format_target(target)}"
                )
            targets.add(target)

    if not targets:
        raise InvalidObsDataError("OBS project metadata contains no repository targets")

    return targets


def read_results(results_xml: str, package: str) -> dict[Target, Result]:
    root = ET.fromstring(results_xml)
    results: dict[Target, Result] = {}

    for result_node in root.findall("result"):
        repository = result_node.get("repository")
        architecture = result_node.get("arch")
        if not repository or not architecture:
            raise InvalidObsDataError(
                "OBS result contains an incomplete repository target"
            )

        target = Target(repository, architecture)
        if target in results:
            raise InvalidObsDataError(
                f"OBS returned duplicate results for {format_target(target)}"
            )

        package_code = None
        for status in result_node.findall("status"):
            if status.get("package") == package:
                package_code = status.get("code")
                break

        results[target] = Result(
            code=result_node.get("code", "unknown"),
            state=result_node.get("state"),
            dirty=result_node.get("dirty") is not None,
            package_code=package_code,
        )

    if not results:
        raise InvalidObsDataError("OBS returned no build results")

    return results


def format_target(target: Target) -> str:
    return f"{target.repository}/{target.architecture}"


def check_readiness(targets: set[Target], results: dict[Target, Result]) -> list[str]:
    pending: list[str] = []
    failed: list[str] = []
    terminal_codes = {"broken", "disabled", "excluded", "failed", "unresolvable"}

    for target in sorted(targets, key=lambda item: (item.repository, item.architecture)):
        label = format_target(target)
        result = results.get(target)
        if result is None:
            pending.append(f"{label}: missing")
            continue

        if result.package_code in terminal_codes:
            failed.append(f"{label}: {result.package_code}")
            continue

        if (
            result.dirty
            or result.code != "published"
            or result.state != "published"
            or result.package_code != "succeeded"
        ):
            dirty = ", dirty" if result.dirty else ""
            pending.append(
                f"{label}: repository={result.code}/{result.state or 'unknown'}, "
                f"package={result.package_code or 'missing'}{dirty}"
            )

    if failed:
        raise ObsReleaseFailedError(
            "OBS release targets failed:\n" + "\n".join(f"- {item}" for item in failed)
        )

    return pending


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_metadata")
    parser.add_argument("results")
    parser.add_argument("package")
    args = parser.parse_args()

    try:
        with open(args.project_metadata, encoding="utf-8") as project_file:
            targets = read_targets(project_file.read())
        with open(args.results, encoding="utf-8") as results_file:
            results = read_results(results_file.read(), args.package)
        pending = check_readiness(targets, results)
    except (ET.ParseError, InvalidObsDataError, ObsReleaseFailedError) as error:
        print(error, file=sys.stderr)
        return 1

    if pending:
        print("OBS release targets are not published:")
        for item in pending:
            print(f"- {item}")
        return 2

    print(f"All {len(targets)} OBS release targets are published and succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
