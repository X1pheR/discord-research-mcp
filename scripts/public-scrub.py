#!/usr/bin/env python3
"""Fail closed on obvious private/deployment material before publication."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "coverage"}
SKIP_CONTENT = {"package-lock.json"}

forbidden_literals = (
    "/" + "srv" + "/" + "hyper" + "shell",
    "." + "hyper" + "shell" + ".eu",
    "ron" + "ald",
)
secret_patterns = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b(?:ghp|github_pat|sk-proj|sk)-[A-Za-z0-9_-]{16,}\b"),
)
private_ipv4 = re.compile(
    r"\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|"
    r"192\.168\.(?:\d{1,3}\.)\d{1,3}|"
    r"172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b"
)
discord_snowflake = re.compile(r"(?<!\d)\d{15,22}(?!\d)")

failures: list[str] = []
for path in sorted(ROOT.rglob("*")):
    if not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
        continue
    rel = path.relative_to(ROOT)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue

    lower = text.lower()
    for literal in forbidden_literals:
        if literal.lower() in lower:
            failures.append(f"{rel}: forbidden private/deployment literal {literal!r}")

    for pattern in secret_patterns:
        if pattern.search(text):
            failures.append(f"{rel}: secret-like material matched {pattern.pattern!r}")

    if rel.name not in SKIP_CONTENT:
        if private_ipv4.search(text):
            failures.append(f"{rel}: RFC1918 address found")
        if discord_snowflake.search(text):
            failures.append(f"{rel}: long numeric Discord-like identifier found; use config or synthetic fixtures")

if failures:
    print("public scrub failed:")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)

print("public scrub passed")
