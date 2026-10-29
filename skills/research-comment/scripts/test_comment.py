import unittest

from comment import check, digest, prepare


class CommentTests(unittest.TestCase):
    def test_disclosure_preserves_evidence_and_identifies_contributors(self):
        findings = "Confirmed at `a1b2c3`. See [source](https://example.com)."
        body = prepare(findings, "@reviewer", "T3 Code", "actual-model").decode("utf-8")
        self.assertTrue(body.startswith(findings + "\n\n"))
        self.assertIn("AI was used to conduct this research.", body)
        self.assertIn("reviewed and approved by @reviewer.", body)
        self.assertIn("Harness: T3 Code\nAI model: actual-model\n", body)

    def test_changed_payload_requires_new_approval(self):
        body = prepare("Findings", "reviewer", "Harness", "Model")
        check(body, digest(body))
        with self.assertRaises(ValueError):
            check(body.replace(b"Findings", b"Other findings"), digest(body))

    def test_rejects_invalid_reviewer_and_missing_provenance(self):
        for reviewer in ("", "someone else", "https://github.com/reviewer", "a--b", "-bot"):
            with self.subTest(reviewer=reviewer), self.assertRaises(ValueError):
                prepare("Findings", reviewer, "Harness", "Model")
        for harness, model in (("", "Model"), ("Harness", " "), ("Harness\nExtra", "Model")):
            with self.subTest(harness=harness, model=model), self.assertRaises(ValueError):
                prepare("Findings", "reviewer", harness, model)

    def test_rejects_empty_findings_and_invalid_digest(self):
        with self.assertRaises(ValueError):
            prepare(" \n", "reviewer", "Harness", "Model")
        with self.assertRaises(ValueError):
            check(b"Findings", "not-a-digest")


if __name__ == "__main__":
    unittest.main()
