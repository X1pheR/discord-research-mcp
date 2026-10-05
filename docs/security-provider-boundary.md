# Security and provider boundary

Discord Research MCP deliberately separates provider access from archive access.

## Trust boundaries

### Discord provider edge

Only the forward collector owns Discord OAuth2 credentials and the Discord Desktop IPC session. The MCP façade receives no Discord secret, refresh token, access token, or Discord IPC mount.

The accepted provider behavior is limited to metadata discovery required for selected-source validation, selected message-event subscriptions, exact-event refetch when needed, explicit forum-thread identity validation, and one bounded GET_CHANNEL call for read_channel.

### Archive edge

The archive bridge receives no Discord credentials. It connects only to a loopback msgvault MCP endpoint and only to msgvault read-only MCP mode.

The product does not read SQLite directly. It does not expose the msgvault native tool namespace. It maps a smaller Discord-specific set of archive operations and revalidates configured source scope.

### Agent edge

The public MCP HTTP listener exposes five read-only Discord tools. No archive miss, archive transport failure, or search miss can call the Discord provider automatically.

## Explicit exclusions

The product does not implement:

- normal-user token or self-bot automation;
- Discord Client Experiment APIs;
- bot fallback;
- sending, editing, deleting, reacting, moderating, or marking reads;
- attachment-binary fetching;
- account-wide message crawling;
- full-history claims for local RPC snapshots;
- hidden fallback from archive to provider;
- msgvault deletion staging, attachment export, or arbitrary mutation tools.

## Credential lifecycle

Static client credentials and bootstrap refresh material are external file inputs. The collector owns the latest rotated refresh token in a private state file and persists a replacement atomically before authenticating with it.

Access tokens remain process-memory only. Corrupt, insecure, rejected, or unpersistable token state fails closed.

## Archive isolation

The recommended topology is:

1. the msgvault writer runs in a network-isolated namespace;
2. a native msgvault read-only MCP helper shares that namespace and binds loopback only;
3. archive-bridge shares the same namespace, calls that loopback endpoint, and exports only a Unix socket;
4. the network-facing Discord MCP façade mounts the Unix socket but does not join the archive namespace.

This preserves a single archive writer and avoids giving the archive/query components Discord credentials or general network reachability.

## Public mirror evidence

Mirror provenance is data provenance, not provider authority. A public-mirror row must remain identifiable as such and never become evidence of direct Discord acquisition or freshness beyond the configured/stored cutoff.

## Failure behavior

- Discord unavailable: live reads fail; archive reads remain local.
- Archive unavailable: archive tools fail; no Discord fallback occurs.
- Invalid selected-source configuration: acquisition/archive scope fails closed.
- Provider identity mismatch: result is rejected.
- Unexpected authorization/write behavior: stop rather than broaden credentials or switch identities.
