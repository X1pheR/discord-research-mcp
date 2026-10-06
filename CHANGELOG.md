# Changelog

## 0.5.2 - 2026-10-06

- Simplify the archive path by querying the existing msgvault loopback REST API directly; the separate msgvault query-MCP sidecar is no longer required.
- Let the existing archive bridge optionally export msgvault's first-party Web UI/API over a private Unix socket, preserving msgvault `network_mode: none`.
- Keep the five Discord MCP tools, source scoping, provenance and no-provider-fallback semantics unchanged.

## v0.5.1

Public packaging and documentation release.

- Added a representative Docker Compose deployment for the complete five-tool surface using the published GHCR image.
- Added `.env.example` and a deployment guide with explicit provider/archive trust boundaries.
- Added the tested compatibility baseline and clarified that msgvault import/writer lifecycle remains deployment-owned.
- Added Compose validation to the canonical verification path and hosted release checks.
- No Discord acquisition, archive-query, tool-contract, or persistence semantics changed.

## v0.5.0

First standalone Discord Research MCP release.

- Extracted the proven Discord Desktop local-RPC/OAuth2 collector, forward observation pipeline, normalization, coverage health, token-state lifecycle, explicit forum-thread seed handling, and bounded live channel reads from deployment-specific source.
- Added a Discord-centred five-tool MCP surface.
- Added a loopback-only msgvault read-only archive adapter exposed internally through a private Unix socket.
- Added explicit direct-vs-public-mirror provenance and incomplete-history semantics.
- Added public repository hygiene, tests, container build, CI, and GHCR release automation.
- Kept source selection, credentials, host paths, private routing, importer execution, backup wiring, and MCP gateway policy outside the product.
