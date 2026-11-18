import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


HERE = Path(__file__).resolve().parent
HEADER = "transaction_id,date,store,type,amount_cents\n"
FIRST = "S1,2026-05-18,东街店,payment,900\n"


class DailyCloseTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)
        self.orders = self.work / "orders.csv"
        self.report = self.work / "report.csv"

    def run_close(self):
        return subprocess.run([sys.executable, HERE / "close.py", "orders.csv", "report.csv"],
                              cwd=self.work, capture_output=True)

    def test_sample_matches_hand_calculated_report(self):
        # 东街：1299 + 501 收，250 + 1 退；西街：899 收，1000 退。
        expected = (HERE / "expected.csv").read_bytes()
        self.orders.write_bytes((HERE / "orders.csv").read_bytes())
        self.report.write_bytes(b"old report\n")
        result = self.run_close()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.report.read_bytes(), expected)

    def assert_rejected(self, last_row):
        self.orders.write_bytes((HEADER + FIRST + last_row + "\n").encode("utf-8"))
        for old_report in (None, b"previous close\n"):
            with self.subTest(old_report=old_report):
                if old_report is None:
                    self.report.unlink(missing_ok=True)
                else:
                    self.report.write_bytes(old_report)
                result = self.run_close()
                self.assertNotEqual(result.returncode, 0)
                if old_report is None:
                    self.assertFalse(self.report.exists())
                else:
                    self.assertEqual(self.report.read_bytes(), old_report)

    def test_duplicate_id_across_stores(self):
        self.assert_rejected("S1,2026-05-18,西街店,refund,10")

    def test_mixed_dates(self):
        self.assert_rejected("S2,2026-05-19,东街店,payment,10")

    def test_bad_amount(self):
        for amount in ("", "ten", "0", "-10", "1.5", "1e2", "NaN"):
            with self.subTest(amount=amount):
                self.assert_rejected(f"S2,2026-05-18,东街店,refund,{amount}")


if __name__ == "__main__":
    unittest.main()
