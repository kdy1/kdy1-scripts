#!/usr/bin/env python3
"""Select the MainQA subagent target from a saved T3 capabilities response.

Without --model, the target is the coordinator's session model: the inherited
provider instance, model, and options. With --model, the target is that
human-specified model. --option overrides or adds a human-specified option.
"""

import argparse
import json
import sys
from pathlib import Path


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
        model_id = catalog.get("inheritedModel")
        if not inherited or not model_id:
            raise ValueError("The session provider or model is not in the capabilities response")
        provider_id = inherited
        base_options = {option.get("id"): option.get("value")
                        for option in catalog.get("inheritedOptions") or [] if option.get("id")}
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
    session_model = provider_id == inherited and model_id == catalog.get("inheritedModel")
    if model is None and not session_model:
        raise ValueError(f"Provider {provider_id} does not list {model_id}; rerun "
                         f"orchestrator_capabilities with search={model_id!r}")

    options = dict(base_options)
    for option_id, raw in requested_options.items():
        if model is None:
            raise ValueError(f"Cannot validate {option_id} because the catalog does not "
                             f"list {model_id}; rerun orchestrator_capabilities with "
                             f"search={model_id!r}")
        options[option_id] = resolve_option(model, option_id, raw)
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
