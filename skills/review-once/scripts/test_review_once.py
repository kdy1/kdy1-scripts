import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from review_once import (cleanup, parse_pr, parse_settings, prepare_local, render_prompt,
                         select_targets, verify)


def catalog(drop=None, values_shape=True):
    def model(model_id, option):
        if values_shape:
            options = [{"id": option, "values": ["low", "high", "xhigh"]}]
        else:
            options = [{"id": option, "type": "select",
                        "options": [{"id": "low"}, {"id": "high"}, {"id": "xhigh"}]}]
        return {"id": model_id, "options": options}

    codex = [model("gpt-6-astra", "reasoningEffort"), model("gpt-6.1-sol", "reasoningEffort")]
    claude = [model("claude-opus-5-5", "effort"), model("claude-sonnet-5-5", "effort")]
    providers = [
        {"providerInstanceId": "codex", "canRunChildTask": True,
         "canRunCrossProviderChildTask": True,
         "models": [m for m in codex if m["id"] != drop]},
        {"providerInstanceId": "claudeAgent", "canRunChildTask": True,
         "canRunCrossProviderChildTask": True,
         "models": [m for m in claude if m["id"] != drop]},
    ]
    return {"inheritedProviderInstanceId": "claudeAgent", "providers": providers,
            "features": {"appOwnedSubagents": True}}


class TargetTests(unittest.TestCase):
    def test_selects_four_reviewers_in_stable_order(self):
        targets = select_targets(catalog())
        self.assertEqual([t["slug"] for t in targets], ["astra", "sol", "opus", "sonnet"])
        self.assertEqual(targets[1]["target"], {"providerInstanceId": "codex", "model": "gpt-6.1-sol",
                                                "options": {"reasoningEffort": "high"}})
        self.assertEqual(targets[2]["target"]["options"], {"effort": "high"})

    def test_defaults_to_high_effort_and_user_settings_override(self):
        targets = select_targets(catalog(), parse_settings(["opus:effort=xhigh"]))
        options = {t["slug"]: t["target"]["options"] for t in targets}
        self.assertEqual(options, {"astra": {"reasoningEffort": "high"},
                                   "sol": {"reasoningEffort": "high"},
                                   "opus": {"effort": "xhigh"},
                                   "sonnet": {"effort": "high"}})

    def test_missing_default_effort_blocks(self):
        data = catalog()
        data["providers"][1]["models"][1]["options"] = []
        with self.assertRaisesRegex(ValueError, "sonnet: claude-sonnet-5-5 does not support effort=high"):
            select_targets(data)

    def test_accepts_structured_content_and_legacy_option_shape(self):
        settings = parse_settings(["astra:reasoningEffort=xhigh"])
        targets = select_targets({"structuredContent": catalog(values_shape=False)}, settings)
        self.assertEqual(targets[0]["target"]["options"], {"reasoningEffort": "xhigh"})

    def test_missing_model_or_unsupported_setting_blocks(self):
        with self.assertRaisesRegex(ValueError, "sonnet"):
            select_targets(catalog(drop="claude-sonnet-5-5"))
        with self.assertRaisesRegex(ValueError, "does not support"):
            select_targets(catalog(), parse_settings(["opus:effort=ultra"]))

    def test_cross_provider_and_subagent_support_required(self):
        data = catalog()
        data["providers"][0]["canRunCrossProviderChildTask"] = False
        with self.assertRaisesRegex(ValueError, "cross-provider"):
            select_targets(data)
        data = catalog()
        data["features"]["appOwnedSubagents"] = False
        with self.assertRaises(ValueError):
            select_targets(data)

    def test_rejects_bad_settings(self):
        for entry in ("unknown:effort=high", "opus-effort-high", "opus:effort="):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                parse_settings([entry])
        self.assertEqual(parse_settings(["opus:fastMode=true"]), {"opus": {"fastMode": True}})


class PrRefTests(unittest.TestCase):
    def test_parses_urls_and_numbers(self):
        self.assertEqual(parse_pr("https://github.com/o/r/pull/12/files"), ("github.com", "o", "r", 12))
        self.assertEqual(parse_pr("7", "o/r"), ("github.com", "o", "r", 7))
        self.assertEqual(parse_pr("7", "ghe.example/o/r"), ("ghe.example", "o", "r", 7))
        for ref, repo in (("7", None), ("https://github.com/o/r/issues/1", None), ("x", "o/r")):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                parse_pr(ref, repo)


class PromptTests(unittest.TestCase):
    manifest = {
        "kind": "pr", "url": "https://github.com/o/r/pull/1", "title": "Fix", "repository": "o/r",
        "baseRef": "main", "baseSha": "b" * 40, "headRef": "fix", "headSha": "h" * 40,
        "mergeBase": "m" * 40, "checkouts": {"opus": "/tmp/run/reviewers/opus"},
    }

    def test_renders_pr_prompt(self):
        text = render_prompt(self.manifest, "opus")
        self.assertIn("git -C /tmp/run/reviewers/opus diff " + "b" * 40 + "..." + "h" * 40, text)
        self.assertIn("gh pr view https://github.com/o/r/pull/1 --comments", text)
        self.assertIn("VERDICT:", text)
        self.assertNotIn("{{", text)

    def test_renders_local_prompt_with_intent(self):
        manifest = dict(self.manifest, kind="local", origin=None, sourcePath="/src/app",
                        includesUncommitted=True, intent="Fix the crash.\nKeep the API.")
        text = render_prompt(manifest, "opus")
        self.assertIn("Local changes in /src/app, not yet a pull request", text)
        self.assertIn("it is not a real commit", text)
        self.assertIn("> Fix the crash.\n> Keep the API.", text)
        self.assertNotIn("gh pr view", text)
        text = render_prompt(dict(manifest, intent=None, includesUncommitted=False), "opus")
        self.assertIn("did not state an intent", text)
        self.assertNotIn("not a real commit", text)

    def test_rejects_unknown_slug_and_leftover_placeholders(self):
        with self.assertRaises(ValueError):
            render_prompt(self.manifest, "sonnet")
        with self.assertRaises(ValueError):
            render_prompt(self.manifest, "opus", template="{{UNKNOWN}}")


def git(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", "-C", str(repo), *args], check=True, env=env,
                          capture_output=True, text=True).stdout.strip()


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "src"
        git(self.tmp.name, "init", "--quiet", "-b", "main", str(self.repo))
        (self.repo / ".gitignore").write_text("ignored.txt\n")
        (self.repo / "a.txt").write_text("one\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "--quiet", "-m", "base")
        git(self.repo, "switch", "--quiet", "-c", "feature")
        (self.repo / "a.txt").write_text("two\n")
        git(self.repo, "commit", "--quiet", "-am", "change a")
        self.manifest = None

    def tearDown(self):
        if self.manifest:
            cleanup(self.manifest)
        self.tmp.cleanup()

    def state(self):
        return (git(self.repo, "status", "--porcelain"), git(self.repo, "rev-parse", "HEAD"),
                git(self.repo, "for-each-ref"), git(self.repo, "stash", "list"))

    def test_snapshots_uncommitted_and_untracked_without_touching_source(self):
        (self.repo / "a.txt").write_text("three\n")
        (self.repo / "new.txt").write_text("new\n")
        (self.repo / "ignored.txt").write_text("secret\n")
        git(self.repo, "add", "a.txt")
        before = self.state()
        self.manifest = prepare_local(str(self.repo), base_ref="main")
        self.assertEqual(self.state(), before)
        self.assertTrue(self.manifest["includesUncommitted"])
        checkout = Path(self.manifest["checkouts"]["sol"])
        self.assertEqual((checkout / "a.txt").read_text(), "three\n")
        self.assertEqual((checkout / "new.txt").read_text(), "new\n")
        self.assertFalse((checkout / "ignored.txt").exists())
        self.assertEqual(verify(self.manifest), ([], []))
        (self.repo / "new.txt").write_text("edited\n")
        (checkout / "a.txt").write_text("tampered\n")
        problems, notes = verify(self.manifest)
        self.assertEqual(len(problems), 1)
        self.assertIn("changed after the review started", notes[0])

    def test_committed_changes_and_explicit_head(self):
        self.manifest = prepare_local(str(self.repo), base_ref="main", intent="  ")
        self.assertFalse(self.manifest["includesUncommitted"])
        self.assertEqual(self.manifest["headSha"], git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(self.manifest["headRef"], "feature")
        self.assertIsNone(self.manifest["intent"])
        cleanup(self.manifest)
        self.manifest = prepare_local(str(self.repo), base_ref="main", head_ref="feature")
        self.assertFalse(self.manifest["reviewsWorkingTree"])

    def test_no_changes_is_rejected_and_leaves_no_run_dir(self):
        before = set(Path(tempfile.gettempdir()).glob("review-once-*"))
        with self.assertRaisesRegex(ValueError, "Nothing to review"):
            prepare_local(str(self.repo), base_ref="feature")
        self.assertEqual(set(Path(tempfile.gettempdir()).glob("review-once-*")), before)

    def test_default_base_falls_back_to_main(self):
        self.manifest = prepare_local(str(self.repo))
        self.assertEqual(self.manifest["baseRef"], "main")


if __name__ == "__main__":
    unittest.main()
