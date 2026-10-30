#!/usr/bin/env python3
"""Render a GitHub small-text footer from observed analysis identities."""

import argparse
from html import escape


def identity(value):
    """Keep the footer on one line and represent missing metadata explicitly."""
    return escape(" ".join(value.split()) or "unknown")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harness", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    print(f"<sub>Static analysis — Harness: {identity(args.harness)}; "
          f"Model: {identity(args.model)}</sub>")


if __name__ == "__main__":
    main()
