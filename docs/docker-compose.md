# Docker Compose deployment

The published image is:

```text
ghcr.io/x1pher/discord-research-mcp:v0.5.2
```

`compose.yaml` is a representative Linux deployment for the complete five-tool MCP surface. It preserves the product's trust boundaries: the Discord collector owns provider credentials, the archive bridge owns no Discord credentials, and the network-facing MCP container receives only private Unix sockets.

## Tested compatibility baseline

| Component | Tested / supported baseline |
| --- | --- |
| Container platform | Docker Engine with Docker Compose v2 on Linux |
| Image architecture | `linux/amd64` |
| Runtime inside image | Node.js 22 |
| Discord provider | Discord Desktop local RPC/IPC with an OAuth2 application authorized for `rpc,identify,guilds,messages.read` |
| Archive backend | `ghcr.io/x1pher/msgvault:0.19.3-x1pher.7` REST API against an existing msgvault writer/data directory |
| MCP transport | Streamable HTTP on `/mcp`; health on `/healthz` |

Other platforms or versions may work, but are not claimed as tested by this release.

## Prerequisites

1. Discord Desktop is running and its local IPC directory is mountable by Docker.
2. You have a Discord OAuth2 application and bootstrap refresh token.
3. A msgvault writer container is already running and its data directory is available on the Docker host.
4. Your archive has been populated separately. Discord Research MCP deliberately does not own msgvault import scheduling or writer lifecycle.

The Compose file does **not** turn forward observations into archive rows by itself. The collector writes normalized observations to the `discord-observations` volume; importing and acknowledging those files remains deployment-owned so msgvault keeps a single writer.

## Configure

Copy the example environment file and edit it:

```sh
cp .env.example .env
```

Create the two secret files referenced by `.env`. Keep them outside Git and readable only by the account that runs Docker.

Edit `examples/selected-sources.json` to contain the Discord guild/channel parents that your deployment is authorized to research. The checked-in IDs are synthetic examples.

At minimum, set `DISCORD_CLIENT_ID`, `DISCORD_IPC_PATH`, `DISCORD_CLIENT_SECRET_PATH`, `DISCORD_REFRESH_TOKEN_PATH`, `MSGVAULT_CONTAINER_NAME`, and `MSGVAULT_DATA_PATH`.

The Discord application's registered redirect URI must match `DISCORD_REDIRECT_URI`.

## Validate and start

```sh
docker compose --env-file .env config -q
docker compose pull
docker compose up -d
```

Check the MCP health endpoint:

```sh
curl --fail http://127.0.0.1:3021/healthz
```

A healthy response requires both private sockets: the live Discord control socket and the archive bridge socket.

The MCP endpoint is `http://127.0.0.1:3021/mcp`.

## Security notes

- The example binds MCP to loopback by default. Use an authenticated reverse proxy before exposing it beyond the local host.
- Do not put Discord client secrets or refresh tokens in `.env`; Compose receives only file paths.
- The `discord-mcp` service has no Discord credential mounts and no msgvault data mount.
- The archive bridge accepts only the loopback address advertised by msgvault `daemon.1.json`, exports a curated archive Unix socket, and may export the first-party Web UI/API through a second Unix socket.
- An archive miss never invokes Discord.
- `read_channel` is a bounded live snapshot and is never persisted automatically.
- Attachment binaries are not acquired.

See [security-provider-boundary.md](security-provider-boundary.md) for the full trust model and [tools.md](tools.md) for the tool contract.
