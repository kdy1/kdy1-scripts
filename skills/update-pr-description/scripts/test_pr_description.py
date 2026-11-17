import json
import tempfile
import unittest
from pathlib import Path

from pr_description import (RUN_PREFIX, check_draft, cleanup, headings, images, issue_refs,
                            load_draft, local_paths, mentions, parse_pr)

OLD_BODY = """## Summary

Fixes the parser.

<!-- stack-metadata: abc -->

![screen](https://github.com/user-attachments/assets/1234)

- [x] Tests added

Closes #12
Refs other/repo#3
Ref ENG-4

cc @alice
"""


def snapshot(body=OLD_BODY, title="fix(parser): handle empty input", template="## Summary\n"):
    return {"owner": "o", "name": "r", "runDir": "/nonexistent",
            "pr": {"title": title, "body": body}, "template": template}


class ParseTests(unittest.TestCase):
    def test_url_and_number(self):
        self.assertEqual(parse_pr("https://github.com/o/r/pull/12/files"), ("github.com", "o", "r", 12))
        self.assertEqual(parse_pr("7", "o/r"), ("github.com", "o", "r", 7))
        self.assertEqual(parse_pr("7", "ghe.example.com/o/r"), ("ghe.example.com", "o", "r", 7))
        with self.assertRaises(ValueError):
            parse_pr("7")


class AnalysisTests(unittest.TestCase):
    def test_issue_refs(self):
        refs = issue_refs(OLD_BODY, "o/r")
        self.assertEqual(refs, {"o/r#12": "closes", "other/repo#3": "refs", "ENG-4": "refs"})
        # Same issue in URL form, and reference lines inside code are ignored.
        text = "Fixes https://github.com/O/R/issues/12\n```\nCloses #99\n```\n"
        self.assertEqual(issue_refs(text, "o/r"), {"o/r#12": "closes"})
        self.assertEqual(issue_refs("This closes #5 in a sentence."), {})

    def test_images_mentions_paths(self):
        self.assertEqual(images(OLD_BODY), {"https://github.com/user-attachments/assets/1234"})
        self.assertEqual(mentions("cc @alice and `@types/node`, mail a@b.com"), {"alice"})
        self.assertEqual(local_paths("see /home/me/x.png and /usr/bin/env"), ["/home/me/x.png"])

    def test_headings_ignore_code_and_comments(self):
        text = "# A\n```\n# not\n```\n<!-- ## hidden -->\n## B ##\n"
        self.assertEqual(headings(text), ["A", "B"])


class CheckTests(unittest.TestCase):
    def test_good_rewrite(self):
        body = OLD_BODY.replace("Fixes the parser.", "The parser now accepts empty input.")
        errors, warnings = check_draft(snapshot(), "fix(parser): accept empty input", body)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_dropped_content_is_an_error(self):
        errors, _ = check_draft(snapshot(), "fix: x", "## Other\n\nRefs #12\n")
        joined = "\n".join(errors)
        self.assertIn("issue reference changed: closes -> refs o/r#12", joined)
        self.assertIn("issue reference removed: refs other/repo#3", joined)
        self.assertIn("image or attachment removed", joined)
        self.assertIn("HTML comment removed: <!-- stack-metadata: abc -->", joined)
        self.assertIn("template heading removed: Summary", joined)

    def test_reference_format_change_is_not_removal(self):
        body = OLD_BODY.replace("Closes #12", "Closes o/r#12")
        errors, _ = check_draft(snapshot(), "fix: x", body)
        self.assertEqual(errors, [])

    def test_template_comments_may_be_removed(self):
        old = "<!-- Describe the change -->\n## Summary\nx\n"
        errors, _ = check_draft(snapshot(old, template="<!-- Describe the change -->\n## Summary\n"),
                                "fix: x", "## Summary\ny\n")
        self.assertEqual(errors, [])

    def test_title_and_warnings(self):
        errors, warnings = check_draft(snapshot(), "Fix stuff", OLD_BODY + "\n/tmp/shot.png @bob\n")
        self.assertIn("local file path in body: /tmp/shot.png", errors)
        self.assertTrue(any("Conventional Commits" in w for w in warnings))
        self.assertIn("mention added: @bob (GitHub notifies this account)", warnings)
        errors, warnings = check_draft(snapshot(), "Fix stuff", OLD_BODY, conventional=False)
        self.assertFalse(any("Conventional" in w for w in warnings))
        errors, _ = check_draft(snapshot(), "", OLD_BODY)
        self.assertIn("title: empty", errors)

    def test_unchecked_box_and_removed_mention_warn(self):
        body = OLD_BODY.replace("[x]", "[ ]").replace("cc @alice", "")
        _, warnings = check_draft(snapshot(), "fix: x", body)
        self.assertIn("checked box removed or unchecked: Tests added", warnings)
        self.assertIn("mention removed: @alice", warnings)


class FileTests(unittest.TestCase):
    def test_load_draft_defaults_and_cleanup(self):
        with tempfile.TemporaryDirectory() as outer:
            run_dir = Path(outer) / f"{RUN_PREFIX}x"
            run_dir.mkdir()
            snap = snapshot()
            snap["runDir"] = str(run_dir)
            (run_dir / "snapshot.json").write_text(json.dumps(snap))
            # No draft files: keep the current text.
            self.assertEqual(load_draft(snap, None, None), (snap["pr"]["title"], OLD_BODY))
            (run_dir / "title.txt").write_text("feat: new\n")
            (run_dir / "body.md").write_text("Body\n\n\n")
            self.assertEqual(load_draft(snap, None, None), ("feat: new", "Body\n"))
            cleanup(run_dir / "snapshot.json")
            self.assertFalse(run_dir.exists())

    def test_cleanup_refuses_other_directories(self):
        with tempfile.TemporaryDirectory() as outer:
            (Path(outer) / "snapshot.json").write_text("{}")
            with self.assertRaises(SystemExit):
                cleanup(Path(outer) / "snapshot.json")


if __name__ == "__main__":
    unittest.main()
