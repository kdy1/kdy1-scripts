import unittest
from unittest import mock

import post_text
from post_text import check, digest, parse_target, prepare


class PrepareTests(unittest.TestCase):
    def test_info_panel_is_on_top_and_names_harness_and_agent(self):
        body = prepare("## Title\n\nBody text.\n", ["T3 Code"], ["Claude Opus 5.5 (claude-opus-5-5)"]).decode("utf-8")
        self.assertEqual(
            body,
            "> [!NOTE]\n"
            "> This text was drafted with AI and posted after human approval.\n"
            ">\n"
            "> - Harness: T3 Code\n"
            "> - AI agent: Claude Opus 5.5 (claude-opus-5-5)\n"
            "\n## Title\n\nBody text.\n",
        )

    def test_several_harnesses_and_agents_use_plural_labels(self):
        body = prepare("Text", ["T3 Code", "Claude Code"], ["Model A", "Model B"]).decode("utf-8")
        self.assertIn("> - Harnesses: T3 Code, Claude Code\n", body)
        self.assertIn("> - AI agents: Model A, Model B\n", body)

    def test_rejects_missing_or_multiline_provenance(self):
        for harnesses, agents in (([], ["A"]), (["H"], []), ([" "], ["A"]), (["H"], ["A\nB"])):
            with self.subTest(harnesses=harnesses, agents=agents), self.assertRaises(ValueError):
                prepare("Text", harnesses, agents)

    def test_rejects_empty_text_and_existing_panel(self):
        with self.assertRaises(ValueError):
            prepare(" \n", ["H"], ["A"])
        with self.assertRaises(ValueError):
            prepare("> [!NOTE]\n> Old panel\n\nText", ["H"], ["A"])

    def test_normalizes_crlf(self):
        self.assertNotIn(b"\r", prepare("a\r\nb", ["H"], ["A"]))


class CheckTests(unittest.TestCase):
    def test_changed_text_requires_new_approval(self):
        body = prepare("Text", ["H"], ["A"])
        check(body, digest(body))
        with self.assertRaises(ValueError):
            check(body.replace(b"Text", b"Other"), digest(body))
        with self.assertRaises(ValueError):
            check(body, "not-a-digest")


class TargetTests(unittest.TestCase):
    def test_parses_issue_and_pull_urls(self):
        self.assertEqual(
            parse_target("https://github.com/o/r/pull/12#issuecomment-1"),
            {"host": "github.com", "owner": "o", "repo": "r", "number": "12"},
        )
        self.assertEqual(parse_target("https://ghe.example.com/o/r/issues/3")["host"], "ghe.example.com")

    def test_rejects_other_urls(self):
        for url in ("https://github.com/o/r", "https://github.com/o/r/discussions/1", "o/r#1"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_target(url)

    def test_post_reads_back_and_detects_mismatch(self):
        body = prepare("Text", ["H"], ["A"])
        created = {"id": 7, "html_url": "https://github.com/o/r/issues/1#issuecomment-7"}
        with mock.patch.object(post_text, "gh_api", side_effect=[created, {"body": body.decode()}]) as api:
            self.assertEqual(post_text.post(body, "https://github.com/o/r/issues/1"), created["html_url"])
        self.assertEqual(api.call_args_list[1].args, ("github.com", "repos/o/r/issues/comments/7"))
        with mock.patch.object(post_text, "gh_api", side_effect=[created, {"body": "changed"}]):
            with self.assertRaises(RuntimeError):
                post_text.post(body, "https://github.com/o/r/issues/1")


if __name__ == "__main__":
    unittest.main()
