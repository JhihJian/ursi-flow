import unittest

from release import latest


class LatestTest(unittest.TestCase):
    def test_simple_versions(self):
        self.assertEqual(latest(["2.0", "1.0"]), "2.0")

    def test_unprefixed_numeric_order(self):
        actual = latest(["1.9", "1.10"])
        expected = "1.10"
        self.assertEqual(actual, expected, f"actual {actual}, expected {expected}")

    def test_prefixed_versions(self):
        self.assertEqual(latest(["v1.2", "v1.3"]), "v1.3")
