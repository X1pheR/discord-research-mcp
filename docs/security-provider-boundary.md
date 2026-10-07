# Security and provider boundary

Discord Research MCP is intentionally read-only, but “read-only” does not mean every internal process is a separate trust boundary. This document describes the actual v0.5.6 reference topology.

## Reference trust model

The reference deployment has two product containers:

- **discord-research** — runs `forward`, `archive-bridge`, and `mcp` under one supervised process tree;
- **msgvault** — separate product/container, sole durable archive writer.

The three Discord child processes share the same container environment, mounts and network namespace. The Unix sockets between them are process-IPC boundaries, not credential-isolation boundaries.

msgvault is separate because durable archive ownership and writer lifecycle are materially different from Discord acquisition.

## Discord provider edge

The `forward` child owns the active Discord Desktop local-RPC/OAuth2 lifecycle. In the combined reference container the sibling processes share the container trust boundary, so deployments must protect the whole `discord-research` container as credential-bearing.

Accepted provider behavior is limited to:

- metadata reads required for selected-source validation;
- selected message-event subscriptions;
- exact-event refetch when needed;
- explicit forum-thread identity validation;
- one bounded `GET_CHANNEL` for an explicit `read_channel` call.

There is no normal-user session token, self-bot, Discord Client Experiment API, write action, reaction/moderation path, or implicit account-wide crawler.

## Archive edge

The `archive-bridge` child receives archive requests only from the sibling MCP process through a private in-container Unix socket.

For the current reference topology it calls an authenticated msgvault HTTP base URL configured by `DISCORD_ARCHIVE_BASE_URL` and reads the API key from `DISCORD_ARCHIVE_API_KEY_FILE`.

The adapter:

- never opens the msgvault database directly;
- exposes only the reviewed Discord archive operations;
- revalidates configured source scope;
- preserves acquisition provenance and incomplete-history semantics;
- treats an archive miss as terminal;
- never falls back to Discord.

The legacy local-runtime-file transport remains supported for compatibility but is not the current recommended deployment.

## msgvault boundary

msgvault is a separate product and the sole archive writer.

The recommended integration is:

- an internal Docker network shared only as required by the deployment;
- msgvault API authentication enabled;
- no unnecessary host-published msgvault port;
- the API key delivered as a secret, not embedded in source or ordinary environment examples.

A reverse proxy or browser authentication layer is deployment-owned and should authenticate to msgvault separately after admitting the human user.

## Agent edge

The public MCP HTTP listener exposes exactly five read-only Discord tools:

- `search_messages`
- `get_message`
- `list_messages`
- `search_thread`
- `read_channel`

No raw msgvault namespace is published.

No archive miss, archive transport failure, or search miss can trigger a Discord provider request automatically.

## Source-selection boundary

Source selection is deployment configuration. Checked-in IDs are synthetic.

A selected forum parent may admit a derived child only when provider metadata binds the child to the selected guild/parent/type. Unknown or mismatched scope fails closed.

## Credential lifecycle

Static Discord client credentials and bootstrap refresh material are external file inputs.

The acquisition application owns the latest rotated refresh token in a private state file and persists a replacement atomically before authenticating with it. Access tokens remain process-memory only.

The msgvault API key is also an external file input. The public repository contains only a configurable file path, never a credential value.

Corrupt, insecure, rejected or unpersistable credential state fails closed.

## Public mirror evidence

Public-mirror provenance is data provenance, not provider authority.

A mirror row remains explicitly `public_git_mirror` evidence with stored repository/commit information and optional deployment cutoff. It never proves direct Discord acquisition or freshness beyond that evidence.

## Explicit exclusions

The product does not implement:

- normal-user token or self-bot automation;
- Discord Client Experiment APIs;
- bot fallback;
- sending, editing, deleting, reacting, moderating, or marking reads;
- attachment-binary fetching;
- automatic account-wide history crawling;
- full-history claims for local RPC snapshots;
- hidden archive-to-provider fallback;
- msgvault deletion staging, attachment export, or arbitrary mutation tools.

## Failure behavior

- Discord unavailable: live reads fail; archive reads may still work.
- msgvault unavailable or unauthenticated: archive tools fail; there is no Discord fallback.
- Invalid selected-source configuration: acquisition/archive scope fails closed.
- Provider identity mismatch: result is rejected.
- Unexpected authorization or write behavior: stop rather than broaden credentials or silently switch identities.
