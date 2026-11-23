"""Offline checks of select-target.py with synthetic capabilities responses."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "select_target", Path(__file__).with_name("select-target.py"))
select = importlib.util.module_from_spec(spec)
spec.loader.exec_module(select)


def catalog(inherited="claudeAgent", model="claude-opus-5-5", **changes):
    record = {
        "inheritedProviderInstanceId": inherited,
        "inheritedModel": model,
        "inheritedOptions": [{"id": "effort", "value": "max"}],
        "features": {"appOwnedSubagents": True},
        "providers": [
            {"providerInstanceId": "codex", "driverKind": "codex", "canRunChildTask": True,
             "canRunCrossProviderChildTask": True,
             "models": [{"id": "gpt-6.2-sol", "options": [
                 {"id": "reasoningEffort", "values": ["low", "high", "xhigh"]}]}]},
            {"providerInstanceId": "claudeAgent", "driverKind": "claudeAgent",
             "canRunChildTask": True, "canRunCrossProviderChildTask": True,
             "models": [{"id": "claude-opus-5-5", "options": [
                 {"id": "effort", "values": ["low", "high", "xhigh", "max"]},
                 {"id": "fastMode", "values": [False, True]}]}]},
            {"providerInstanceId": "grok", "driverKind": "grok", "canRunChildTask": True,
             "models": [{"id": "grok-4.7"}]},
            {"providerInstanceId": "cursor", "driverKind": "cursor",
             "canRunChildTask": False, "models": []},
        ],
    }
    record.update(changes)
    return record


class SelectTargetTest(unittest.TestCase):
    def test_claude_session_model_with_high_effort(self):
        self.assertEqual(select.select_target(catalog()), {
            "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5",
            "options": {"effort": "high"}})

    def test_codex_session_model_with_high_reasoning_effort(self):
        response = {"structuredContent": catalog("codex", "gpt-6.2-sol")}
        self.assertEqual(select.select_target(response), {
            "providerInstanceId": "codex", "model": "gpt-6.2-sol",
            "options": {"reasoningEffort": "high"}})

    def test_requested_effort_overrides_high(self):
        target = select.select_target(catalog(), requested_options={"effort": "xhigh"})
        self.assertEqual(target["options"], {"effort": "xhigh"})

    def test_other_requested_option_keeps_high_effort(self):
        target = select.select_target(catalog(), requested_options={"fastMode": "true"})
        self.assertEqual(target["options"], {"effort": "high", "fastMode": True})

    def test_requested_cross_provider_model_gets_high_effort(self):
        target = select.select_target(catalog(), "gpt-6.2-sol")
        self.assertEqual(target, {"providerInstanceId": "codex", "model": "gpt-6.2-sol",
                                  "options": {"reasoningEffort": "high"}})

    def test_rejects_model_without_effort_option(self):
        with self.assertRaisesRegex(ValueError, "no reasoning effort"):
            select.select_target(catalog("grok", "grok-4.7"))

    def test_rejects_missing_session_model(self):
        with self.assertRaisesRegex(ValueError, "session model"):
            select.select_target(catalog(model=None))

    def test_rejects_unlisted_session_model(self):
        with self.assertRaisesRegex(ValueError, "search="):
            select.select_target(catalog(model="claude-sonnet-5-5"))

    def test_rejects_unknown_option_value(self):
        with self.assertRaisesRegex(ValueError, "does not accept"):
            select.select_target(catalog(), requested_options={"effort": "ultra"})

    def test_rejects_other_provider_without_model(self):
        with self.assertRaisesRegex(ValueError, "--model"):
            select.select_target(catalog(), provider_id="codex")

    def test_rejects_provider_without_child_tasks(self):
        with self.assertRaisesRegex(ValueError, "cannot run"):
            select.select_target(catalog("cursor"), "x", "cursor")

    def test_rejects_missing_app_owned_subagents(self):
        with self.assertRaisesRegex(ValueError, "app-owned"):
            select.select_target(catalog(features={}))

    def test_rejects_missing_session_provider(self):
        with self.assertRaisesRegex(ValueError, "session provider"):
            select.select_target(catalog(None))

    def test_parse_options_rejects_malformed_pair(self):
        with self.assertRaises(ValueError):
            select.parse_options(["effort"])


if __name__ == "__main__":
    unittest.main()
