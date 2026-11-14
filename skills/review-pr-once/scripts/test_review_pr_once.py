import unittest

from review_pr_once import parse_pr, parse_settings, render_prompt, select_targets


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
        self.assertEqual(targets[1]["target"], {"providerInstanceId": "codex", "model": "gpt-6.1-sol"})
        self.assertNotIn("options", targets[2]["target"])

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
        "url": "https://github.com/o/r/pull/1", "title": "Fix", "repository": "o/r",
        "baseRef": "main", "baseSha": "b" * 40, "headRef": "fix", "headSha": "h" * 40,
        "mergeBase": "m" * 40, "checkouts": {"opus": "/tmp/run/reviewers/opus"},
    }

    def test_renders_bundled_template(self):
        text = render_prompt(self.manifest, "opus")
        self.assertIn("git -C /tmp/run/reviewers/opus diff " + "b" * 40 + "..." + "h" * 40, text)
        self.assertIn("VERDICT:", text)
        self.assertNotIn("{{", text)

    def test_rejects_unknown_slug_and_leftover_placeholders(self):
        with self.assertRaises(ValueError):
            render_prompt(self.manifest, "sonnet")
        with self.assertRaises(ValueError):
            render_prompt(self.manifest, "opus", template="{{UNKNOWN}}")


if __name__ == "__main__":
    unittest.main()
