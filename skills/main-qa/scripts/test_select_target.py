"""Offline checks of select-target.py with synthetic capabilities responses."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "select_target", Path(__file__).with_name("select-target.py"))
select = importlib.util.module_from_spec(spec)
spec.loader.exec_module(select)


def catalog(inherited="claudeAgent", model="claude-opus-5-5", options=None, **changes):
    record = {
        "inheritedProviderInstanceId": inherited,
        "inheritedModel": model,
        "inheritedOptions": options if options is not None else [{"id": "effort", "value": "high"}],
        "features": {"appOwnedSubagents": True},
        "providers": [
            {"providerInstanceId": "codex", "canRunChildTask": True,
             "canRunCrossProviderChildTask": True,
             "models": [{"id": "gpt-6-luna", "options": [
                 {"id": "reasoningEffort", "values": ["low", "high", "xhigh"]}]}]},
            {"providerInstanceId": "claudeAgent", "canRunChildTask": True,
             "canRunCrossProviderChildTask": True,
             "models": [{"id": "claude-opus-5-5", "options": [
                 {"id": "effort", "values": ["low", "high", "xhigh"]},
                 {"id": "fastMode", "values": [False, True]}]}]},
            {"providerInstanceId": "cursor", "canRunChildTask": False, "models": []},
        ],
    }
    record.update(changes)
    return record


class SelectTargetTest(unittest.TestCase):
    def test_session_claude_model(self):
        self.assertEqual(select.select_target(catalog()), {
            "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5",
            "options": {"effort": "high"}})

    def test_session_codex_model(self):
        response = {"structuredContent": catalog(
            "codex", "gpt-6-luna", [{"id": "reasoningEffort", "value": "xhigh"}])}
        self.assertEqual(select.select_target(response), {
            "providerInstanceId": "codex", "model": "gpt-6-luna",
            "options": {"reasoningEffort": "xhigh"}})

    def test_unlisted_session_model_keeps_session_options(self):
        target = select.select_target(catalog(model="claude-sonnet-5-5"))
        self.assertEqual(target["model"], "claude-sonnet-5-5")
        self.assertEqual(target["options"], {"effort": "high"})

    def test_requested_option_overrides_session_option(self):
        target = select.select_target(catalog(), requested_options={"effort": "xhigh"})
        self.assertEqual(target["options"], {"effort": "xhigh"})

    def test_boolean_option_uses_catalog_value(self):
        target = select.select_target(catalog(), requested_options={"fastMode": "true"})
        self.assertIs(target["options"]["fastMode"], True)

    def test_requested_cross_provider_model(self):
        target = select.select_target(catalog(), "gpt-6-luna",
                                      requested_options={"reasoningEffort": "xhigh"})
        self.assertEqual(target, {"providerInstanceId": "codex", "model": "gpt-6-luna",
                                  "options": {"reasoningEffort": "xhigh"}})

    def test_requested_model_does_not_inherit_session_options(self):
        target = select.select_target(catalog(), "gpt-6-luna")
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
            select.select_target(catalog(inherited="cursor", model="x"))

    def test_rejects_missing_app_owned_subagents(self):
        with self.assertRaisesRegex(ValueError, "app-owned"):
            select.select_target(catalog(features={}))

    def test_rejects_missing_session_model(self):
        with self.assertRaisesRegex(ValueError, "session provider or model"):
            select.select_target(catalog(model=None))

    def test_parse_options_rejects_malformed_pair(self):
        with self.assertRaises(ValueError):
            select.parse_options(["effort"])


if __name__ == "__main__":
    unittest.main()
