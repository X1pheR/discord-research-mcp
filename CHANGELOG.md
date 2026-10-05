# Changelog

## v0.5.0

First standalone Discord Research MCP release.

- Extracted the proven Discord Desktop local-RPC/OAuth2 collector, forward observation pipeline, normalization, coverage health, token-state lifecycle, explicit forum-thread seed handling, and bounded live channel reads from deployment-specific source.
- Added a Discord-centred five-tool MCP surface.
- Added a loopback-only msgvault read-only archive adapter exposed internally through a private Unix socket.
- Added explicit direct-vs-public-mirror provenance and incomplete-history semantics.
- Added public repository hygiene, tests, container build, CI, and GHCR release automation.
- Kept source selection, credentials, host paths, private routing, importer execution, backup wiring, and MCP gateway policy outside the product.
