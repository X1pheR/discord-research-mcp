# Security Policy

## Supported versions

Security fixes are applied to the current release line.

## Reporting a vulnerability

Prefer GitHub private vulnerability reporting for this repository when it is available.

If private vulnerability reporting is unavailable, open a GitHub issue that contains only a request for a private contact path. Do not include credentials, private Discord content, exploit payloads, or other sensitive details in a public issue.

## Security boundary

Discord Research MCP is read-only by design.

- No normal-user Discord session token or self-bot automation.
- No Discord Client Experiment API or detection-evasion path.
- No send, edit, delete, reaction, moderation, or read-state action.
- No automatic provider fallback after an archive miss.
- No attachment-binary acquisition.
- The agent-facing archive surface does not expose msgvault mutation, deletion staging, attachment export, or arbitrary query tools.
- Archive access is expected to remain local. The built-in archive bridge accepts only loopback HTTP MCP endpoints and exports a Unix socket.
- Credentials belong in external secret/file mounts. Never place credentials in source, command arguments, logs, test fixtures, or MCP results.

See docs/security-provider-boundary.md for the full trust model.
