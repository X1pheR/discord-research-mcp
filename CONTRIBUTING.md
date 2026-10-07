# Contributing

Contributions should stay focused on Discord Research MCP's read-only acquisition, provenance and curated archive-research responsibilities.

## Development baseline

The tested development runtime is Node.js 22.

Clone the repository and run the canonical verification gate:

```sh
./scripts/verify.sh
```

That is the same repository-local gate used by CI and release publication.

## Change expectations

For a behavior change:

1. describe the intended behavior and boundary;
2. add or update tests before treating the change as accepted;
3. keep the five-tool read-only contract and no-provider-fallback rule explicit;
4. update README/docs when public setup, configuration, security or compatibility changes;
5. add a concise changelog entry when the change is user-visible.

Keep pull requests bounded. Avoid generic frameworks, extra services or deployment-specific machinery when an internal module/process is sufficient.

## Public-data boundary

Do not commit or paste:

- Discord credentials, authorization codes, refresh/access tokens;
- private Discord message content used only for local acceptance;
- msgvault API keys or archive secrets;
- private hostnames, IP addresses or Homelab-only paths;
- real source IDs unless they are intentionally public evidence and required by the product.

Fixtures should use synthetic identifiers and content.

## Deployment ownership

This repository owns reusable product behavior and public reference packaging. A consuming deployment owns real source selection, secret delivery, reverse proxy/browser auth, importer scheduling, host paths, backups and recovery.

msgvault is a separate product. Do not copy its archive implementation into this repository.

## Security reports

Do not open a public issue containing vulnerability details or sensitive evidence. Follow [`SECURITY.md`](SECURITY.md).
