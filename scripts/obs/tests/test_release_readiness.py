#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[1]
FIXTURE_DIR = pathlib.Path(__file__).resolve().parent / "fixtures"
SPEC = importlib.util.spec_from_file_location(
    "release_readiness", SCRIPT_DIR / "check-release-readiness.py"
)
assert SPEC and SPEC.loader
release_readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_readiness)


def fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


class ReleaseReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.targets = release_readiness.read_targets(fixture("project.xml"))
        self.published = fixture("results-published.xml")

    def check(self, results_xml: str) -> list[str]:
        results = release_readiness.read_results(results_xml, "gitmun")
        return release_readiness.check_readiness(self.targets, results)

    def test_all_targets_are_published(self) -> None:
        self.assertEqual(self.check(self.published), [])

    def test_building_target_is_pending(self) -> None:
        results = self.published.replace(
            'repository="AppImage" arch="x86_64" code="published" state="published"',
            'repository="AppImage" arch="x86_64" code="building" state="building"',
        )
        self.assertIn("AppImage/x86_64", self.check(results)[0])

    def test_package_success_before_publication_is_pending(self) -> None:
        results = self.published.replace(
            'code="published" state="published"',
            'code="finished" state="building"',
            1,
        )
        self.assertIn("repository=finished/building", self.check(results)[0])

    def test_missing_target_is_pending(self) -> None:
        results = self.published.replace(
            '  <result repository="AppImage" arch="x86_64" code="published" state="published">\n'
            '    <status package="gitmun" code="succeeded"/>\n'
            '  </result>\n',
            "",
        )
        self.assertEqual(self.check(results), ["AppImage/x86_64: missing"])

    def test_terminal_package_failure_is_rejected(self) -> None:
        results = self.published.replace('code="succeeded"', 'code="failed"', 1)
        with self.assertRaises(release_readiness.ObsReleaseFailedError):
            self.check(results)


if __name__ == "__main__":
    unittest.main()
