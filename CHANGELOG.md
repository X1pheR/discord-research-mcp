# Changelog

## v0.5.6 - 2026-10-07

Public packaging and documentation consistency release.

- Reconciled the README, architecture diagram, security model and Docker deployment guide with the accepted two-container topology.
- Replaced the stale three-service v0.5.2 Compose example with one `discord-research` v0.5.6 service that runs `forward`, `archive-bridge`, and `mcp` together and connects to an existing authenticated msgvault writer.
- Replaced obsolete msgvault container/data-path settings with shared-network, archive-base-URL and API-key-file configuration.
- Added public-package regression checks so old bridge-container/network-namespace examples cannot silently return.
- Standardized CI and release publication on the repository-local verification gate.
- Updated `@modelcontextprotocol/sdk` to `1.32.1`, resolving the applicable High-severity GHSA-6qxp-vccf-f47h advisory before release.
- No Discord acquisition, MCP tool, archive provenance, observation, or persistence semantics changed.

## v0.5.5 - 2026-10-06

- Added the supervised `serve` runtime with `forward`, `archive-bridge`, and `mcp` as child processes in one Discord Research container.
- Added authenticated msgvault HTTP archive access through `DISCORD_ARCHIVE_BASE_URL` and `DISCORD_ARCHIVE_API_KEY_FILE`.
- Preserved the existing local runtime-file archive transport as a compatibility path.
- Kept the five-tool read-only MCP contract and no-provider-fallback semantics unchanged.

## v0.5.4 - 2026-10-06

- Normalized browser-origin metadata in the private msgvault Web proxy compatibility path so same-origin msgvault browser mutations remain valid behind an authenticated reverse proxy.
- Added regression coverage for that proxy behavior.
- No Discord provider or archive-query semantics changed.

## v0.5.3 - 2026-10-06

- Added the combined `serve` runtime to supervise Discord acquisition and MCP processes under one container lifecycle.
- Updated public architecture documentation for the combined runtime.
- Kept standalone role commands available for compatibility and targeted testing.

## v0.5.2 - 2026-10-06

- Simplified the archive path by querying the existing msgvault loopback REST API directly; the separate msgvault query-MCP sidecar was no longer required.
- Allowed the archive bridge compatibility path to export msgvault's first-party Web UI/API over a private Unix socket.
- Kept the five Discord MCP tools, source scoping, provenance and no-provider-fallback semantics unchanged.

## v0.5.1 - 2026-10-06

Public packaging and documentation release.

- Added a representative Docker Compose deployment for the complete five-tool surface using the published GHCR image.
- Added `.env.example` and a deployment guide with explicit provider/archive trust boundaries.
- Added the tested compatibility baseline and clarified that msgvault import/writer lifecycle remains deployment-owned.
- Added Compose validation to the canonical verification path and hosted release checks.
- No Discord acquisition, archive-query, tool-contract, or persistence semantics changed.

## v0.5.0 - 2026-10-05

First standalone Discord Research MCP release.

- Extracted the proven Discord Desktop local-RPC/OAuth2 collector, forward observation pipeline, normalization, coverage health, token-state lifecycle, explicit forum-thread seed handling, and bounded live channel reads from deployment-specific source.
- Added a Discord-centred five-tool MCP surface.
- Added a loopback msgvault archive adapter exposed internally through a private Unix socket.
- Added explicit direct-vs-public-mirror provenance and incomplete-history semantics.
- Added public repository hygiene, tests, container build, CI, and GHCR release automation.
- Kept source selection, credentials, host paths, private routing, importer execution, backup wiring, and MCP gateway policy outside the product.
