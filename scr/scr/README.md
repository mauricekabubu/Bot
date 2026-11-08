# Atom Maurice AI

Atom Maurice AI is a WhatsApp Web assistant for individual chats only—never groups. It uses WPPConnect, Gemini, and SQLite, with a Kenyan conversational voice.

## What it does

- Strictly rejects groups (`@g.us`), broadcasts/statuses, self messages, and unsupported identifiers before any AI request or memory write.
- Queues messages per user, deduplicates incoming IDs, rate-limits users, and isolates SQLite memory per WhatsApp identifier.
- Uses Gemini through the official `@google/genai` SDK; when not configured it responds safely instead of crashing.
- Includes deterministic calculator support (`calc 12 * 4`), a SQLite reminder foundation, optional web search integration, and safe document metadata validation.
- Stores supported incoming media only from verified individual chats, with per-file and total-storage limits. PDFs, TXT, and DOCX are additionally validated and staged temporarily; document text extraction is not implemented, so uploads are acknowledged but not analyzed.

## Setup on Windows PowerShell

Use Node.js 20+ LTS. From the workspace root:

```powershell
cd .\scr
npm install
Copy-Item .env.example .env
notepad .env
npm test
npm start
```

Set `GEMINI_API_KEY` in `.env`; `gemini-3.8-flash` is the default model. On first start, scan the QR code in the terminal from WhatsApp: **Linked devices → Link a device**. WPPConnect stores its isolated Chrome profile under `%LOCALAPPDATA%\Atom\whatsapp-session\session-atom-maurice-wppconnect` to keep browser storage out of OneDrive sync.

To reset the linked account, stop the process and remove only `%LOCALAPPDATA%\Atom\whatsapp-session\session-atom-maurice-wppconnect` in Explorer, then start again. Do not delete the whole `data` folder if you want to retain memories and reminders. The previous WhatsApp profiles are left untouched.

## Outbound messaging diagnostics and test mode

Every application reply and reminder is sent through the SQLite-backed outbound service. A returned WPPConnect message ID is recorded as **sent** (accepted by the client), not delivered. WPPConnect 2.3.6 wires `onAck` to `MsgStore.on("change:ack")`; it is a store-wide acknowledgement-change callback, not scoped to sends made by this Atom process. It may report messages sent through Atom, WhatsApp Web, or another linked device, and may report changes for previously-created messages when their ACK changes while the listener is active. The callback does not identify which client/device originated an outgoing message. Atom updates status only when the complete serialized WhatsApp message ID exactly matches one unique persisted outbound record. Unmatched ACKs are expected and logged without changing delivery state. ACK `2` means received/delivered, ACK `3` means read, and negative ACK values represent failure conditions. Unrecognized acknowledgements and send exceptions are not treated as delivery; uncertain sends are not automatically retried.

From `scr`, use these CLI commands:

```powershell
# Check initialization, authentication, connection, send capability, and ack support.
npm start -- --whatsapp-diagnostic

# Look up a contact without sending a message.
npm start -- --lookup-contact +254700123456

# Explicitly approve one test recipient; approval is stored in this database.
npm start -- --approve-test-recipient +254700123456

# Send only after explicitly confirming the allowlisted contact is a dedicated test contact.
npm start -- --test-send +254700123456 --confirm

# Review totals, delivery/read counts, and recent failures.
npm start -- --outbound-report

# Manage the suppression list when needed.
npm start -- --suppress-recipient +254700123456
npm start -- --unsuppress-recipient +254700123456
```

Test sends require a prior allowlist entry, a successful WPPConnect contact lookup, and the explicit `--confirm` flag; alternatively, set comma-separated numeric recipients in `OUTBOUND_TEST_RECIPIENTS`. Use only a dedicated test contact. Test sends are idempotent for each recipient/day, so repeated execution on the same day will not send another copy. They require a live WhatsApp connection and may require scanning the existing WPPConnect QR. The CLI reports the returned WhatsApp message ID and waits up to 15 seconds for delivery/read acknowledgement. CLI commands use the configured SQLite database and never reset the WhatsApp session.

Stop the regular bot with `Ctrl+C` before running the one-shot connection diagnostic or test-send CLI commands; do not launch two clients against the same Chrome profile.

WPPConnect 2.3.6 has a separate 180-second `deviceSyncTimeout`; its startup countdown can produce `Auto close configured/remain` logs. The timer starts after authentication while WPPConnect waits for `inChat`, and is canceled only after the page-load readiness step completes. It is not reset by ordinary message activity. Atom sets the separate `autoClose` option to `0`. The timeout can be increased with `WHATSAPP_DEVICE_SYNC_TIMEOUT_MS` (180000–900000 ms); it cannot be disabled through this setting, preserving the startup protection. The countdown remaining active after `inChat` is expected while WPPConnect finishes page readiness; its 180-second deadline cannot explain a browser disconnect one second later.

The adapter launches Chromium with WPPConnect 2.3.6's own `initBrowser` helper, attaches Puppeteer page/browser/process listeners before passing that browser into WPPConnect, and then lets WPPConnect create the client/page. This preserves WPPConnect's existing launch arguments and options while ensuring page-close, page-crash, target, browser-disconnect, close-call, and process-exit/error diagnostics exist before WhatsApp startup. These imports use WPPConnect 2.3.6 internal modules; revalidate them when upgrading WPPConnect. `browserClose` is emitted by WPPConnect's `browser.disconnected` listener; it does not identify why Puppeteer disconnected. No unexpected closure was reproduced in a live, no-op-handler run: the existing session reached `inChat` and `CONNECTED`, remained available during the observation window, and closed with exit code 0 only after the test intentionally called `destroy`. An unexpected disconnect needs its corresponding page/browser/process diagnostic event before assigning a root cause. The application initialization guard prevents overlapping clients; automatic reconnect is deliberately not attempted without identifying the failure and confirming the browser process/profile is released.

When `LOG_LEVEL=debug`, incoming callback diagnostics report only message type, ID presence, media-availability booleans, and safe field paths/types. They do not log message content, IDs, contact identifiers, URLs, media keys, or credentials. In installed WPPConnect 2.3.6, `onMessage` serializes the original ID as `Message.id` (a string), and the underlying `MessageId` uses `_serialized`; chat IDs can be strings or `Wid` objects, group participants are exposed as `author`, and message timestamps are numeric. `hasMedia` reflects the WPPConnect media flag or a supported attachment type. `mediaDownloadAvailable` requires a message ID and the installed client's `downloadMedia` method; it indicates an attempt can be made, not that bytes were actually downloaded.

Automatic media downloads are limited to verified individual customer conversations. Groups, newsletters, status broadcasts, protocol events, and unknown events are never downloaded by this feature. Files use generated names and restrictive file permissions, are deduplicated by chat and WhatsApp message ID, and are recorded in the versioned SQLite `incoming_media` table with success/failure status and SHA-256. `MAX_FILE_SIZE_MB` caps each file (default 10 MB); `WHATSAPP_MEDIA_MAX_TOTAL_MB` caps stored media (default 500 MB); `WHATSAPP_MEDIA_PATH` sets the storage directory. A missing WhatsApp ID is never synthesized: that event is recorded as skipped with a nullable ID. Media references may expire or be unavailable, in which case failure is recorded and no successful download is claimed.

An individual can opt out by sending `STOP`; subsequent sends are suppressed. `START` removes that recipient's suppression. Suppression also blocks reminders and test messages. Do not use this diagnostic feature for bulk or unsolicited messaging.

## Optional web research

Set both `WEB_SEARCH_ENDPOINT` and `WEB_SEARCH_API_KEY`. The endpoint must accept a `q` query parameter and Bearer authentication. Without both values the search tool is unavailable and must not be represented as a search result.

## Safety and privacy

Messages/documents are untrusted input. The bot never executes arbitrary user code, shell commands, uploads, or filesystem operations. Sensitive actions are permission-gated. Logs mask likely credential values and avoid message bodies. `.env`, local auth, databases, logs, and temporary files are ignored by Git.

## Architecture

`whatsapp/` owns connection, event classification, filtering, and per-user ordering; `ai/` owns prompts, context, Gemini, and orchestration; `memory/` owns SQLite; `tools/` contains constrained capabilities; `security/` owns validation, permissions, and limits. Incoming WPPConnect 2.3.6 messages are classified by chat ID and message metadata: only verified `@c.us` and one-to-one `@lid` contacts enter the customer AI pipeline, group messages retain their group and participant IDs but are excluded, newsletters are stored in the separate `newsletter_updates` table, and status/system/unknown events are excluded and safely logged without message bodies. Newsletter rows use an internal `event_uuid`; `whatsapp_message_id` remains nullable when WPPConnect provides no message ID, and valid WhatsApp IDs are unique per channel. Events without WhatsApp IDs are retained and explicitly marked, but cannot be reliably deduplicated against later callbacks without an upstream ID.

One-to-one `@lid` conversations are accepted only after WPPConnect `getChatById` verifies `isUser === true`, `isGroup === false`, and that the ID matches the chat or its contact ID; the chat must not be a broadcast, status, or read-only chat. An `@lid` sender/participant alone is never sufficient. Since WPPConnect 2.3.6 documents `sendText` for `@c.us` recipients, outbound LID replies first use WA-JS 4.7.2 `WPP.contact.getPnLidEntry()` to obtain an exact LID-to-phone mapping, then verify the mapped ID is still a private user chat. No address conversion is guessed; missing mappings or failed private-chat checks prevent sending. The original LID remains the conversation and stored recipient ID. Test-recipient approval and suppression also accept serialized LID IDs.

Gemini requests use the configured model with a 60-second per-request timeout and up to three application attempts. Structured diagnostics record model, duration, attempt, and response length without logging message contents. A generated answer is still sent if conversation-history persistence fails; that storage failure is logged separately.

On normal application startup, Atom calls WPPConnect 2.3.6's documented `getAllUnreadMessages()` once after connection. This API returns partial unread records (documented as messages with ack `-1`), not a paginated full-history API. Atom sorts available records by timestamp, caps processing at `WHATSAPP_UNREAD_RECOVERY_LIMIT` (default 50, maximum 500), skips known non-private chat IDs and system event types, then sends candidate private messages through the same chat-verification and handling path as live messages. LID recovery still requires resolved `isUser` metadata. Completed WhatsApp message IDs are recorded in the versioned `inbound_message_events` table, preventing reprocessing after restart; interrupted processing can be retried, and outbound idempotency prevents duplicate replies if a send was already accepted. Events without an upstream WhatsApp ID cannot be durably deduplicated. WPPConnect's unread API is not guaranteed to return every offline message or full chat history; older messages no longer marked unread require manual recovery.

WPPConnect 2.3.6's send API returns a serialized message ID in the returned message; its `onAck` callback exposes an ID object with `_serialized`, plus `id`, `remote`, and `fromMe` fields. Atom uses the full `_serialized` value (or the exact string representation) for equality; `id.id` alone and `remote` alone are not message identifiers and are never used to match. ACKs that arrive while a send is still in flight are held in a bounded, expiring buffer, then correlated only against an exact ID after persistence. Duplicate pending ACKs are suppressed, timers remove expired entries, and ambiguous duplicate database IDs are rejected rather than updating an arbitrary record. The callback's `fromMe` flag can indicate whether WhatsApp considers a message sent by the linked account, but cannot distinguish Atom from WhatsApp Web or another linked device. Private incoming events have a cumulative handler diagnostic summary (`whatsapp_handler_diagnostics_summary`) every five minutes, including received candidates, verified/rejected private chats, group/newsletter events, AI starts, and outbound reply attempts; per-event stage logs remain available for accepted messages.

## Tests

`npm test` runs Node's built-in test runner without connecting WhatsApp or Gemini. It verifies message filtering, metadata filtering, rate limits, persistent isolated memory, upload validation, sensitive-action permissions, Gemini diagnostics, and verified LID recipient resolution.

## Operational notes

Reminders are checked while the process is running. Known pre-acceptance failures are retried at most three times; uncertain sends are not resent automatically. Existing messages, memories, and reminders are preserved by transactional, versioned schema migrations. Long-term memory is saved only on explicit requests such as `remember preference: I prefer concise answers`; use `show memories` and `forget memory <id>` to inspect/delete individual entries. `clear memory` still requires `CONFIRM` to delete all long-term memories and conversation history. Passwords, keys, and tokens are rejected as memory. For dependable delivery, run Atom under a Windows service/process manager now, or a Linux service manager on a VPS later. WPPConnect automates WhatsApp Web and is not affiliated with or endorsed by WhatsApp or Meta. WhatsApp changes can break it and account restrictions are possible. Use it responsibly and under WhatsApp's terms.
