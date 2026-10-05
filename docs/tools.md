# MCP tool reference

All tools are read-only. There is no write, delete, stage, export, attachment-download, or arbitrary-provider tool.

| Tool | Purpose | Important limits |
| --- | --- | --- |
| search_messages | Full-text search over locally archived Discord bodies in configured archive sources. | limit 1–20. Archive-only. A miss never calls Discord. |
| get_message | Read bounded body context for one search/list result by archive_id. | max_chars 1–4000. Source scope is revalidated. |
| list_messages | List a bounded page in one archived Discord conversation/thread. | limit 1–30. Archive-only. |
| search_thread | Search within one archived conversation by scanning a bounded local message page. | At most 30 messages are scanned per call; result limit 1–20. |
| read_channel | Read one explicit account-visible Discord channel from the authorized local RPC session. | Exactly one provider GET_CHANNEL; no persistence or subscription; never full history. |

## search_messages

Inputs:

- query — required body-search string.
- limit — optional, default 10, maximum 20.
- offset — optional bounded result offset.

Each result includes archive_id, Discord message_id, archive_conversation_id, Discord channel_id when available, timestamp, author summary, search snippets/matches, and provenance.

## get_message

Inputs:

- archive_id — required positive archive result ID.
- offset — optional body offset.
- max_chars — optional, default 2000, maximum 4000.

The tool revalidates that the message belongs to the configured discord_local archive scope. Attachment results contain metadata only; storage URLs, hashes, and binary content are not returned.

## list_messages

Inputs:

- archive_conversation_id — required.
- limit — optional, default 20, maximum 30.
- offset — optional.

Results are ordered chronologically within the returned page and preserve per-message provenance.

## search_thread

Inputs:

- archive_conversation_id — required.
- query — required.
- limit — optional, default 10, maximum 20.
- offset — optional.

The current implementation scans at most 30 locally archived messages from the conversation and reports scanned_messages, scan_limit, has_more, and complete_history=false.

## read_channel

Input:

- channel_id — required Discord snowflake.

The tool performs exactly one Discord local-RPC GET_CHANNEL call through the already-authenticated collector. It returns only the messages present in that response and labels the result with coverage=bounded_current_client_snapshot, provider_operation=GET_CHANNEL, provenance.acquisition=live_rpc, and complete_history=false.

It does not persist the response, subscribe the channel, enumerate other channels, download attachment binaries, or invoke the archive.

## Provenance

Direct local archive evidence:

~~~json
{"acquisition":"local_rpc_observation","complete_history":false}
~~~

Public mirror evidence includes stored repository/commit provenance and, when configured by the deployment, the mirror cutoff.

No result may infer full history from archive presence.
