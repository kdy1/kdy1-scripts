#!/usr/bin/env python3
"""Track Static Analysis unit coverage across turns, queued runs, and passes."""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

STATUSES = ("pending", "running", "complete", "blocked")
FIRST_FOCUS = "full coverage of every assigned path"
PASS_FOCI = (
    "cross-unit contracts, callers, and configuration",
    "error, boundary, and malformed-input paths",
    "state, lifetime, ordering, and concurrency",
    "differential and runtime checks against tests, fixtures, specs, "
    "or reference implementations",
    "units with the fewest confirmed findings, reread line by line",
)


def default_path(scope):
    """Return a stable ledger path for a resolved scope outside any repository."""
    scope = Path(scope).resolve()
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    digest = hashlib.sha256(str(scope).encode()).hexdigest()[:12]
    return base / "static-analysis" / f"{scope.name or 'root'}-{digest}.json"


def focus_for(pass_number):
    """Return the default focus for a pass number."""
    if pass_number <= 1:
        return FIRST_FOCUS
    return PASS_FOCI[(pass_number - 2) % len(PASS_FOCI)]


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save(path, ledger):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def new_unit(label, paths):
    return {"label": label, "paths": paths, "status": "pending",
            "owner": None, "note": None}


def init(path, plan_data, revision):
    """Create a ledger, or resume one for the same scope and revision."""
    if path.exists():
        ledger = load(path)
        if ledger["scope"] == plan_data["scope"] and ledger["revision"] == revision:
            return ledger, "resumed"
    ledger = {
        "scope": plan_data["scope"],
        "revision": revision,
        "pass": 1,
        "focus": focus_for(1),
        "history": [],
        "units": {unit["id"]: new_unit(unit["label"], unit["paths"])
                  for unit in plan_data["units"]},
    }
    return ledger, "created"


def add(ledger, unit_id, label, paths):
    if unit_id in ledger["units"]:
        raise ValueError(f"Unit already exists: {unit_id}")
    ledger["units"][unit_id] = new_unit(label, paths)


def mark(ledger, unit_id, status, owner, note):
    if unit_id not in ledger["units"]:
        raise ValueError(f"Unknown unit: {unit_id}")
    unit = ledger["units"][unit_id]
    unit["status"] = status
    if owner is not None:
        unit["owner"] = owner
    if note is not None:
        unit["note"] = note


def by_status(ledger):
    groups = {status: [] for status in STATUSES}
    for unit_id in sorted(ledger["units"]):
        groups[ledger["units"][unit_id]["status"]].append(unit_id)
    return groups


def next_action(ledger):
    """Return the coordinator's next required action for this ledger."""
    groups = by_status(ledger)
    if groups["pending"]:
        action = "dispatch"
    elif groups["blocked"]:
        action = "reassign"
    elif groups["running"]:
        action = "continue"
    else:
        action = "new-pass"
    return {
        "action": action,
        "pass": ledger["pass"],
        "focus": ledger["focus"],
        "revision": ledger["revision"],
        **groups,
    }


def new_pass(ledger, focus):
    """Start the next pass after every unit of the current pass is complete."""
    unfinished = [unit_id for unit_id, unit in ledger["units"].items()
                  if unit["status"] != "complete"]
    if unfinished:
        raise ValueError("Current pass is not complete: " + ", ".join(sorted(unfinished)))
    ledger["history"].append({"pass": ledger["pass"], "focus": ledger["focus"]})
    ledger["pass"] += 1
    ledger["focus"] = focus or focus_for(ledger["pass"])
    for unit in ledger["units"].values():
        unit.update(status="pending", owner=None, note=None)


def resolve_path(args, plan_data=None):
    if args.ledger:
        return Path(args.ledger)
    scope = args.scope or (plan_data or {}).get("scope")
    if not scope:
        raise ValueError("Pass --ledger or --scope")
    return default_path(scope)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ledger", help="Ledger path (default: derived from the scope)")
    common.add_argument("--scope", help="Scope used to derive the default ledger path")
    commands = parser.add_subparsers(dest="command", required=True)

    init_parser = commands.add_parser("init", parents=[common],
                                      help="Create or resume a ledger from plan-units.py JSON")
    init_parser.add_argument("--plan", required=True, help="plan-units.py JSON file, or - for stdin")
    init_parser.add_argument("--revision", required=True)

    add_parser = commands.add_parser("add", parents=[common], help="Add a cross-cutting unit")
    add_parser.add_argument("--id", required=True)
    add_parser.add_argument("--label", required=True)
    add_parser.add_argument("--path", action="append", default=[], dest="paths")

    mark_parser = commands.add_parser("mark", parents=[common], help="Set a unit status")
    mark_parser.add_argument("--unit", required=True)
    mark_parser.add_argument("--status", required=True, choices=STATUSES)
    mark_parser.add_argument("--owner")
    mark_parser.add_argument("--note")

    commands.add_parser("next", parents=[common], help="Print the next required action")

    pass_parser = commands.add_parser("new-pass", parents=[common],
                                      help="Start the next pass after full coverage")
    pass_parser.add_argument("--focus", help="Override the default focus for the pass")

    commands.add_parser("status", parents=[common], help="Print the full ledger")

    args = parser.parse_args()
    try:
        if args.command == "init":
            source = sys.stdin if args.plan == "-" else open(args.plan, encoding="utf-8")
            with source:
                plan_data = json.load(source)
            path = resolve_path(args, plan_data)
            ledger, state = init(path, plan_data, args.revision)
            save(path, ledger)
            print(json.dumps({"ledger": str(path), "state": state, **next_action(ledger)},
                             indent=2))
            return
        path = resolve_path(args)
        ledger = load(path)
        if args.command == "add":
            add(ledger, args.id, args.label, args.paths)
        elif args.command == "mark":
            mark(ledger, args.unit, args.status, args.owner, args.note)
        elif args.command == "new-pass":
            new_pass(ledger, args.focus)
        elif args.command == "status":
            print(json.dumps({"ledger": str(path), **ledger}, indent=2))
            return
        if args.command != "next":
            save(path, ledger)
        print(json.dumps({"ledger": str(path), **next_action(ledger)}, indent=2))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Ledger update failed: {error}\n")


if __name__ == "__main__":
    main()
