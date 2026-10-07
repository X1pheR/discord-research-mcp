# Docker Compose deployment

The published reference image is:

```text
ghcr.io/x1pher/discord-research-mcp:v0.5.6
```

The repository `compose.yaml` runs one `discord-research` service. It expects an existing msgvault writer on a shared Docker network. Together those are the reference **two-container product topology**.

msgvault is not defined in this repository because it is a separate product with its own release, storage and writer lifecycle.

## Tested compatibility baseline

| Component | Tested / supported baseline |
| --- | --- |
| Container platform | Docker Engine with Docker Compose v2 on Linux |
| Discord Research image | `ghcr.io/x1pher/discord-research-mcp:v0.5.6` |
| Image architecture | `linux/amd64` |
| Runtime inside image | Node.js 22 |
| Discord provider | Discord Desktop local RPC/IPC with OAuth2 scopes `rpc,identify,guilds,messages.read` |
| Archive backend | msgvault `0.19.3-x1pher.7` authenticated HTTP API |
| MCP transport | Streamable HTTP on `/mcp`; health on `/healthz` |

Other platforms or versions may work, but they are not claimed as tested by this release.

## Runtime shape

The `discord-research` container runs three supervised child processes:

- `forward` — Discord provider/acquisition lifecycle;
- `archive-bridge` — curated authenticated msgvault reads;
- `mcp` — five-tool agent-facing MCP server.

They deliberately share one container trust boundary. Private `/control` and `/archive-control` sockets are tmpfs-only process IPC.

msgvault remains a separate container because it owns durable archive state and the single-writer lifecycle.

## Prerequisites

1. Discord Desktop is running and its local IPC directory can be mounted read-only into the container.
2. You have a Discord OAuth2 application and bootstrap refresh token.
3. A msgvault writer is already running.
4. msgvault listens on an internal Docker network address and requires an API key.
5. Both containers share a Docker network.
6. Your deployment separately owns observation import/acknowledgement so msgvault remains the sole archive writer.

The Discord application's registered redirect URI must match `DISCORD_REDIRECT_URI`.

## Prepare msgvault

Configure msgvault according to its own documentation. The relevant server shape is an authenticated internal endpoint, for example:

```toml
[server]
bind_addr = "0.0.0.0"
api_port = 8080
api_key = "replace-with-a-strong-secret"
```

Do **not** publish that port on the Docker host unless your deployment has a separate reason to do so.

Create or reuse a shared network and attach msgvault to it. One generic example is:

```sh
docker network create msgvault 2>/dev/null || true
docker network connect msgvault msgvault 2>/dev/null || true
```

The example assumes the existing writer container is named `msgvault`. If your deployment uses another DNS name, set `DISCORD_ARCHIVE_BASE_URL` accordingly.

An unauthenticated request should fail:

```sh
docker run --rm --network msgvault curlimages/curl:8.17.0 \
  -sS -o /dev/null -w '%{http_code}\n' \
  http://msgvault:8080/api/v1/stats
```

The expected status is `401`.

## Configure Discord Research

Copy the example environment file:

```sh
cp .env.example .env
mkdir -p runtime/secrets
```

Create these secret files outside Git:

- Discord client secret;
- Discord bootstrap refresh token;
- the same msgvault API key configured on the writer.

Keep them readable only by the account that runs Docker.

Edit `examples/selected-sources.json` with the guild/channel parents your deployment is authorized to research. The checked-in IDs are synthetic.

Important environment values:

| Variable | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | Discord OAuth2 application ID. |
| `DISCORD_IPC_PATH` | Host path containing the Discord Desktop IPC socket. |
| `DISCORD_CLIENT_SECRET_PATH` | Host path to the Discord client-secret file. |
| `DISCORD_REFRESH_TOKEN_PATH` | Host path to the bootstrap refresh-token file. |
| `MSGVAULT_NETWORK` | External Docker network shared with msgvault. |
| `DISCORD_ARCHIVE_BASE_URL` | msgvault HTTP base URL reachable on that network. |
| `MSGVAULT_API_KEY_PATH` | Host path to the msgvault API-key file. |
| `DISCORD_MCP_BIND` | Host binding for the MCP HTTP listener. |

## Validate and start

```sh
docker compose --env-file .env config -q
docker compose pull
docker compose up -d
```

Check health:

```sh
curl --fail http://127.0.0.1:3021/healthz
```

A healthy response requires both live Discord RPC and authenticated archive connectivity.

The MCP endpoint is:

```text
http://127.0.0.1:3021/mcp
```

## Archive import ownership

The `forward` process writes normalized private JSONL observations. This repository does **not** run a msgvault writer or import scheduler.

A consuming deployment may submit those observation files through msgvault's supported import path, but it must keep one authoritative writer and own:

- importer invocation/scheduling;
- acknowledgement or cleanup of successfully imported files;
- persistent host paths;
- backup and recovery.

An archive miss from an MCP tool never contacts Discord.

## Security notes

- The example binds the MCP listener to host loopback by default.
- Do not put Discord or msgvault secret values in `.env`; only paths to secret files belong there.
- The three Discord child processes share one container trust boundary. Do not describe them as separate credential-isolated containers.
- msgvault authentication is mandatory for the current reference topology.
- The public Compose file defines no msgvault service and therefore cannot publish a msgvault host port.
- `read_channel` is a bounded current snapshot and is never persisted automatically.
- Attachment binaries are not acquired.

See [`security-provider-boundary.md`](security-provider-boundary.md) for the trust model and [`tools.md`](tools.md) for the MCP contract.
