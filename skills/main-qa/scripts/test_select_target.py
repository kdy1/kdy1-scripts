"""Offline checks of select-target.py with synthetic capabilities responses."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "select_target", Path(__file__).with_name("select-target.py"))
select = importlib.util.module_from_spec(spec)
spec.loader.exec_module(select)


def catalog(inherited="claudeAgent", **changes):
    record = {
        "inheritedProviderInstanceId": inherited,
        "inheritedModel": "claude-opus-5-5",
        "inheritedOptions": [{"id": "effort", "value": "max"}],
        "features": {"appOwnedSubagents": True},
        "providers": [
            {"providerInstanceId": "codex", "driverKind": "codex", "canRunChildTask": True,
             "canRunCrossProviderChildTask": True,
             "models": [{"id": "gpt-6-luna", "options": [
                 {"id": "reasoningEffort", "values": ["low", "high", "xhigh"]}]}]},
            {"providerInstanceId": "claudeAgent", "driverKind": "claudeAgent",
             "canRunChildTask": True, "canRunCrossProviderChildTask": True,
             "models": [{"id": "claude-opus-5-5", "options": [
                 {"id": "effort", "values": ["low", "high", "xhigh", "max"]}]},
                        {"id": "claude-sonnet-5-5", "options": [
                 {"id": "effort", "values": ["low", "high", "xhigh"]},
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
    def test_claude_session_uses_sonnet_not_session_model(self):
        self.assertEqual(select.select_target(catalog()), {
            "providerInstanceId": "claudeAgent", "model": "claude-sonnet-5-5"})

    def test_codex_session_uses_luna_xhigh(self):
        response = {"structuredContent": catalog("codex")}
        self.assertEqual(select.select_target(response), {
            "providerInstanceId": "codex", "model": "gpt-6-luna",
            "options": {"reasoningEffort": "xhigh"}})

    def test_requested_option_applies_to_default_model(self):
        target = select.select_target(catalog(), requested_options={"effort": "xhigh"})
        self.assertEqual(target["options"], {"effort": "xhigh"})

    def test_boolean_option_uses_catalog_value(self):
        target = select.select_target(catalog(), requested_options={"fastMode": "true"})
        self.assertIs(target["options"]["fastMode"], True)

    def test_requested_session_model(self):
        target = select.select_target(catalog(), "claude-opus-5-5")
        self.assertEqual(target, {"providerInstanceId": "claudeAgent",
                                  "model": "claude-opus-5-5"})

    def test_rejects_session_without_default(self):
        with self.assertRaisesRegex(ValueError, "No default"):
            select.select_target(catalog("grok"))

    def test_rejects_unlisted_default_model(self):
        response = catalog()
        response["providers"][1]["models"].pop()
        with self.assertRaisesRegex(ValueError, "search="):
            select.select_target(response)

    def test_requested_cross_provider_model(self):
        target = select.select_target(catalog(), "gpt-6-luna",
                                      requested_options={"reasoningEffort": "xhigh"})
        self.assertEqual(target, {"providerInstanceId": "codex", "model": "gpt-6-luna",
                                  "options": {"reasoningEffort": "xhigh"}})

    def test_requested_model_gets_no_default_options(self):
        target = select.select_target(catalog("codex"), "gpt-6-luna")
        self.assertNotIn("options", target)

    def test_rejects_unknown_option_value(self):
        with self.assertRaisesRegex(ValueError, "does not accept"):
            select.select_target(catalog(), requested_options={"effort": "ultra"})

    def test_rejects_unlisted_requested_model(self):
        with self.assertRaisesRegex(ValueError, "search="):
            select.select_target(catalog(), "gpt-5.6-luna")

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
