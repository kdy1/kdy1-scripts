#!/usr/bin/env python3
"""Select the MainQA subagent target from a saved T3 capabilities response.

Without --model, the target is the low-cost default model for the coordinator's
session provider: claude-sonnet-5-5 on Claude, gpt-6-luna with xhigh reasoning on
Codex. The session model itself (for example Opus) is never inherited. With
--model, the target is that human-specified model. --option overrides or adds a
human-specified option.
"""

import argparse
import json
import sys
from pathlib import Path

# Default subagent model and options per driver kind of the session provider.
DEFAULTS = {
    "claudeAgent": ("claude-sonnet-5-5", {}),
    "codex": ("gpt-6-luna", {"reasoningEffort": "xhigh"}),
}


def find_model(provider, model_id):
    for model in provider.get("models") or []:
        if model.get("id") == model_id:
            return model
    return None


def option_values(option):
    values = option.get("values")
    if values is None:
        values = [value.get("id") if isinstance(value, dict) else value
                  for value in option.get("options") or []]
    return values


def resolve_option(model, option_id, raw):
    """Return the catalog value of option_id that matches raw, or fail."""
    for option in model.get("options") or []:
        if option.get("id") != option_id:
            continue
        for value in option_values(option):
            if value == raw or str(value).lower() == str(raw).lower():
                return value
        raise ValueError(f"Model {model['id']} does not accept {option_id}={raw}")
    raise ValueError(f"Model {model['id']} has no option {option_id}")


def eligible(provider, inherited):
    if provider.get("canRunChildTask") is not True:
        return False
    return (provider.get("providerInstanceId") == inherited
            or provider.get("canRunCrossProviderChildTask") is True)


def parse_options(pairs):
    options = {}
    for pair in pairs:
        option_id, sep, value = pair.partition("=")
        if not sep or not option_id or not value:
            raise ValueError(f"Expected --option ID=VALUE, got {pair!r}")
        options[option_id] = value
    return options


def select_target(response, model_id=None, provider_id=None, requested_options=None):
    if response.get("isError"):
        raise ValueError("T3 capabilities returned an error")
    catalog = response.get("structuredContent", response)
    if not isinstance(catalog, dict) or not isinstance(catalog.get("providers"), list):
        raise ValueError("Expected a T3 capabilities object with providers")
    if catalog.get("features", {}).get("appOwnedSubagents") is not True:
        raise ValueError("T3 app-owned subagents are unavailable")
    inherited = catalog.get("inheritedProviderInstanceId")
    requested_options = requested_options or {}
    providers = {provider.get("providerInstanceId"): provider
                 for provider in catalog["providers"] if provider.get("providerInstanceId")}

    if model_id is None:
        if provider_id and provider_id != inherited:
            raise ValueError("--provider differs from the session provider; also pass --model")
        if not inherited or inherited not in providers:
            raise ValueError("The session provider is not in the capabilities response")
        kind = providers[inherited].get("driverKind")
        if kind not in DEFAULTS:
            raise ValueError(f"No default subagent model for {kind} sessions; "
                             "pass the human-specified --model")
        provider_id = inherited
        model_id, base_options = DEFAULTS[kind]
    else:
        base_options = {}
        if provider_id is None:
            listing = [pid for pid, provider in providers.items()
                       if eligible(provider, inherited) and find_model(provider, model_id)]
            if inherited in listing:
                provider_id = inherited
            elif len(listing) == 1:
                provider_id = listing[0]
            elif listing:
                raise ValueError(f"Several providers list {model_id}: {', '.join(listing)}; "
                                 "pass --provider")
            else:
                raise ValueError(f"No eligible provider lists {model_id}; rerun "
                                 f"orchestrator_capabilities with search={model_id!r}")

    provider = providers.get(provider_id)
    if provider is None:
        raise ValueError(f"Provider {provider_id} is not in the capabilities response")
    if not eligible(provider, inherited):
        raise ValueError(f"Provider {provider_id} cannot run delegated child tasks")
    model = find_model(provider, model_id)
    if model is None:
        raise ValueError(f"Provider {provider_id} does not list {model_id}; rerun "
                         f"orchestrator_capabilities with search={model_id!r}")

    options = {option_id: resolve_option(model, option_id, value)
               for option_id, value in {**base_options, **requested_options}.items()}
    target = {"providerInstanceId": provider_id, "model": model_id}
    if options:
        target["options"] = options
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("capabilities", type=Path, help="Saved raw catalog or MCP structured response")
    parser.add_argument("--model", help="Human-specified model ID for subagents")
    parser.add_argument("--provider", help="Human-specified providerInstanceId for subagents")
    parser.add_argument("--option", action="append", default=[], metavar="ID=VALUE",
                        help="Human-specified model option, for example effort=xhigh")
    args = parser.parse_args()
    try:
        target = select_target(json.loads(args.capabilities.read_text()), args.model,
                               args.provider, parse_options(args.option))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        parser.exit(1, f"MainQA target blocked: {error}\n")
    json.dump(target, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
