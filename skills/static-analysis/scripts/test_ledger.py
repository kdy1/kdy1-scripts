"""Offline checks for the coverage ledger."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("ledger.py")
SPEC = importlib.util.spec_from_file_location("ledger", SCRIPT)
ledger_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger_module)

PLAN = {
    "scope": "/repo/src",
    "units": [
        {"id": "unit-01", "label": "a", "paths": ["a/one.py"]},
        {"id": "unit-02", "label": "b", "paths": ["b/two.py"]},
    ],
}


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.ledger, state = ledger_module.init(Path("/nonexistent/ledger.json"), PLAN, "abc")
        self.assertEqual(state, "created")

    def test_new_ledger_starts_with_dispatch(self):
        result = ledger_module.next_action(self.ledger)
        self.assertEqual(result["action"], "dispatch")
        self.assertEqual(result["pass"], 1)
        self.assertEqual(result["pending"], ["unit-01", "unit-02"])

    def test_blocked_units_require_reassignment_before_continue(self):
        ledger_module.mark(self.ledger, "unit-01", "running", "worker-1", None)
        ledger_module.mark(self.ledger, "unit-02", "blocked", None, "provider error")
        self.assertEqual(ledger_module.next_action(self.ledger)["action"], "reassign")
        ledger_module.mark(self.ledger, "unit-02", "running", "worker-2", None)
        self.assertEqual(ledger_module.next_action(self.ledger)["action"], "continue")

    def test_full_coverage_requests_a_new_pass(self):
        for unit_id in ("unit-01", "unit-02"):
            ledger_module.mark(self.ledger, unit_id, "complete", None, None)
        self.assertEqual(ledger_module.next_action(self.ledger)["action"], "new-pass")
        ledger_module.new_pass(self.ledger, None)
        result = ledger_module.next_action(self.ledger)
        self.assertEqual(result["action"], "dispatch")
        self.assertEqual(result["pass"], 2)
        self.assertEqual(result["focus"], ledger_module.PASS_FOCI[0])
        self.assertEqual(self.ledger["history"][0]["pass"], 1)

    def test_new_pass_rejects_incomplete_coverage(self):
        ledger_module.mark(self.ledger, "unit-01", "complete", None, None)
        with self.assertRaises(ValueError):
            ledger_module.new_pass(self.ledger, None)

    def test_focus_rotates_after_first_pass(self):
        foci = [ledger_module.focus_for(number) for number in range(1, 9)]
        self.assertEqual(foci[0], ledger_module.FIRST_FOCUS)
        self.assertEqual(foci[1:6], list(ledger_module.PASS_FOCI))
        self.assertEqual(foci[6], ledger_module.PASS_FOCI[0])

    def test_add_rejects_colliding_unit(self):
        ledger_module.add(self.ledger, "cross-01", "contracts", ["api.py"])
        self.assertEqual(ledger_module.next_action(self.ledger)["pending"],
                         ["cross-01", "unit-01", "unit-02"])
        with self.assertRaises(ValueError):
            ledger_module.add(self.ledger, "unit-01", "dup", [])

    def test_resume_keeps_same_scope_and_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "ledger.json"
            ledger_module.mark(self.ledger, "unit-01", "complete", None, None)
            ledger_module.save(path, self.ledger)
            resumed, state = ledger_module.init(path, PLAN, "abc")
            self.assertEqual(state, "resumed")
            self.assertEqual(resumed["units"]["unit-01"]["status"], "complete")
            fresh, state = ledger_module.init(path, PLAN, "def")
            self.assertEqual(state, "created")
            self.assertEqual(fresh["units"]["unit-01"]["status"], "pending")


if __name__ == "__main__":
    unittest.main()
