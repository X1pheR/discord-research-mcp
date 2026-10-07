#!/usr/bin/env python3
"""Verify public packaging and documentation stay aligned with the current release."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_VERSION = "0.5.6"
EXPECTED_IMAGE = f"ghcr.io/x1pher/discord-research-mcp:v{EXPECTED_VERSION}"

CURRENT_PUBLIC_FILES = [
    "README.md",
    "compose.yaml",
    ".env.example",
    "docs/docker-compose.md",
    "docs/security-provider-boundary.md",
    "SECURITY.md",
]

FORBIDDEN = {
    "MSGVAULT_CONTAINER_NAME": "obsolete msgvault container-name coupling",
    "MSGVAULT_DATA_PATH": "obsolete direct msgvault data mount",
    "network_mode: container:": "obsolete shared-network-namespace deployment",
    "unix//run/msgvault-web": "obsolete msgvault Web Unix-socket proxy",
    "ghcr.io/x1pher/discord-research-mcp:v0.5.2": "stale public image version",
}


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def fail(message: str) -> None:
    raise SystemExit(f"public package verification failed: {message}")


def verify_sources() -> None:
    package = json.loads(read("package.json"))
    if package.get("version") != EXPECTED_VERSION:
        fail(f"package.json version is {package.get('version')!r}, expected {EXPECTED_VERSION!r}")

    mcp_source = read("src/mcp.js")
    if f"version: '{EXPECTED_VERSION}'" not in mcp_source:
        fail("MCP server version does not match package release")

    for rel in CURRENT_PUBLIC_FILES:
        body = read(rel)
        for token, meaning in FORBIDDEN.items():
            if token in body:
                fail(f"{rel} contains {meaning}: {token}")

    compose = read("compose.yaml")
    required_compose = [
        "discord-research:",
        EXPECTED_IMAGE,
        "command: [serve]",
        "DISCORD_ARCHIVE_BASE_URL:",
        "DISCORD_ARCHIVE_API_KEY_FILE:",
        "MSGVAULT_API_KEY_PATH",
        "external: true",
    ]
    for token in required_compose:
        if token not in compose:
            fail(f"compose.yaml missing required current contract: {token}")

    for obsolete_service in ("discord-forward:", "discord-mcp:", "discord-archive-bridge:"):
        if obsolete_service in compose:
            fail(f"compose.yaml still defines obsolete service {obsolete_service}")

    readme = read("README.md")
    required_readme = [
        "docs/tools.md",
        "docs/docker-compose.md",
        "docs/security-provider-boundary.md",
        "SECURITY.md",
        "CONTRIBUTING.md",
        "./scripts/verify.sh",
        EXPECTED_IMAGE,
        "two product containers",
    ]
    for token in required_readme:
        if token not in readme:
            fail(f"README.md missing required landing-page route/identity: {token}")

    security = read("docs/security-provider-boundary.md")
    for token in (
        "two product containers",
        "authenticated msgvault HTTP",
        "share the same container",
    ):
        if token not in security:
            fail(f"security boundary does not state current trust model: {token}")


def verify_rendered_compose(path: Path) -> None:
    rendered = json.loads(path.read_text(encoding="utf-8"))
    services = rendered.get("services") or {}
    if set(services) != {"discord-research"}:
        fail(f"rendered Compose services are {sorted(services)}, expected only discord-research")

    service = services["discord-research"]
    if service.get("image") != EXPECTED_IMAGE:
        fail(f"rendered image is {service.get('image')!r}, expected {EXPECTED_IMAGE!r}")

    command = service.get("command")
    if command not in (["serve"], "serve"):
        fail(f"rendered command is {command!r}, expected serve")

    env = service.get("environment") or {}
    if env.get("DISCORD_ARCHIVE_BASE_URL") != "http://msgvault:8080/":
        fail("rendered Compose does not use the example authenticated msgvault HTTP base URL")
    if env.get("DISCORD_ARCHIVE_API_KEY_FILE") != "/run/secrets/msgvault-api-key":
        fail("rendered Compose does not use the msgvault API-key secret file")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compose-json", type=Path)
    args = parser.parse_args()

    verify_sources()
    if args.compose_json:
        verify_rendered_compose(args.compose_json)

    print("public package verification passed")


if __name__ == "__main__":
    main()
