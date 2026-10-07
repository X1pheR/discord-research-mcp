# Security Policy

## Supported versions

Security fixes are applied to the current release line.

## Reporting a vulnerability

Prefer GitHub private vulnerability reporting for this repository when it is available.

If private vulnerability reporting is unavailable, open a GitHub issue that contains only a request for a private contact path. Do **not** include credentials, private Discord content, exploit payloads, access tokens, refresh tokens, archive API keys, or other sensitive details in a public issue.

## Security boundary

Discord Research MCP is read-only by design.

- No normal-user Discord session token or self-bot automation.
- No Discord Client Experiment API or detection-evasion path.
- No send, edit, delete, reaction, moderation, or read-state action.
- No automatic provider fallback after an archive miss.
- No attachment-binary acquisition.
- The agent-facing archive surface does not expose msgvault mutation, deletion staging, attachment export, or arbitrary query tools.
- The reference `discord-research` container runs the `forward`, `archive-bridge`, and `mcp` child processes in one trust boundary.
- The archive backend is a separate msgvault writer reached through an authenticated internal HTTP API in the current reference topology.
- The public example does not publish a msgvault host port.
- Discord and msgvault credentials belong in external read-only secret files. Never place credential values in source, command arguments, logs, fixtures, screenshots, issue reports, or MCP results.

See [`docs/security-provider-boundary.md`](docs/security-provider-boundary.md) for the full trust model.

## Dependency and upstream reports

For vulnerabilities in this repository's adapter/runtime code or container packaging, use the reporting path above.

For a vulnerability that belongs to Discord, msgvault, Node.js, the MCP SDK, or another independent upstream dependency, also follow that project's security process. Do not include private account/archive evidence unless the recipient explicitly needs it and the disclosure is appropriate.
