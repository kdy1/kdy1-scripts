#!/usr/bin/env python3
"""Select a supported MainQA target from a saved T3 capabilities response."""

import argparse
import json
import sys
from pathlib import Path

MODEL = "gpt-5.6-luna"


def select_target(response, preferred=None):
    if response.get("isError"):
        raise ValueError("T3 capabilities returned an error")
    catalog = response.get("structuredContent", response)
    if not isinstance(catalog, dict) or not isinstance(catalog.get("providers"), list):
        raise ValueError("Expected a T3 capabilities object with providers")
    if catalog.get("features", {}).get("appOwnedSubagents") is not True:
        raise ValueError("T3 app-owned subagents are unavailable")
    inherited = catalog.get("inheritedProviderInstanceId")
    eligible = []
    for provider in catalog["providers"]:
        provider_id = provider.get("providerInstanceId")
        if not provider_id or provider.get("canRunChildTask") is not True:
            continue
        if preferred and provider_id != preferred:
            continue
        if provider_id != inherited and provider.get("canRunCrossProviderChildTask") is not True:
            continue
        for model in provider.get("models", []):
            if model.get("id") != MODEL:
                continue
            for option in model.get("options") or []:
                if (option.get("id") == "reasoningEffort"
                        and option.get("type") == "select"
                        and any(value.get("id") == "xhigh" for value in option.get("options", []))):
                    eligible.append(provider_id)
    if not eligible:
        raise ValueError("No eligible provider supports gpt-5.6-luna with reasoningEffort=xhigh")
    selected = inherited if inherited in eligible else eligible[0]
    return {"providerInstanceId": selected, "model": MODEL,
            "options": {"reasoningEffort": "xhigh"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capabilities", type=Path, help="Saved raw catalog or MCP structured response")
    parser.add_argument("--provider", help="Require this exact providerInstanceId")
    args = parser.parse_args()
    try:
        target = select_target(json.loads(args.capabilities.read_text()), args.provider)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        parser.exit(1, f"MainQA target blocked: {error}\n")
    print(json.dumps(target, indent=2))


if __name__ == "__main__":
    main()
