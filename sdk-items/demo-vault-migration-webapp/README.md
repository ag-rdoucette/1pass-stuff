# 1Password Vault Migration Tool

A self-hosted web application for migrating vaults between 1Password accounts. Built with the [1Password JavaScript SDK](https://developer.1password.com/docs/sdks/) (v0.4.0-beta.2) and the [1Password CLI](https://developer.1password.com/docs/cli/get-started).

## Overview

The tool provides a browser-based interface to:

- Connect to source and destination 1Password accounts
- Browse, search, and select source vaults with item counts
- Track migration progress in real time via Server-Sent Events
- Download detailed migration logs for auditing and troubleshooting

Three authentication modes are supported:

| Mode | How it works | Best for |
|---|---|---|
| **Service Account** | Paste source + destination service account tokens directly in the browser | Docker, quick one-off migrations |
| **Desktop Auth** | Connects through the 1Password desktop app — no tokens needed | Migrating personal/private vaults, accounts without service accounts |
| **1Password Environments (.env)** | Credentials loaded from a `.env` file at startup or via reload button | Repeated migrations, scripted workflows |

## Requirements

### Docker (service account mode only)

- [Docker](https://docs.docker.com/get-started/get-docker/) and Docker Compose
- Two [1Password service accounts](https://developer.1password.com/docs/service-accounts/get-started#create-a-service-account): source (read) and destination (create)

### Local Node.js (all three modes)

- Node.js 18+
- [1Password CLI](https://developer.1password.com/docs/cli/get-started) installed and available on PATH
- For desktop auth: 1Password desktop app running and signed into both accounts

## Quick start

### Docker

```bash
docker compose up -d
```

Open `https://localhost:3001` and accept the self-signed certificate warning. Select **Docker** on the welcome page, then paste your service account tokens.

### Local Node.js

```bash
npm install
node webapp.js
```

Open `https://localhost:3001`. Select **Local Node.js** on the welcome page.

For `.env` mode, create a `.env` file in the project root:

```env
# Service account mode
AUTH_MODE=service-account
SOURCE_TOKEN=ops_xxx...
DEST_TOKEN=ops_xxx...

# Or desktop auth mode
AUTH_MODE=desktop
SOURCE_ACCOUNT=My Old Team
DEST_ACCOUNT=My New Team
```

The `.env` can be added or changed while the app is running — click the reload button on the welcome page.

## Usage

1. Choose your deployment method and authenticate.
2. A table of source vaults appears with item counts. Use the search bar to filter by name or ID. Selected vaults sort to the top.
3. Click **Migrate Selected**. The table filters to show only selected vaults with live status updates. A rate limit estimate appears for service account migrations.
4. Once complete, review the summary. Click **Show All Vaults** to see the full list again. Previously migrated vaults show a "✓ Migrated" badge and trigger a duplication warning if selected again.
5. Click **Download Logs** for a full breakdown including any failures.

## How migration works

### Service account mode

Vaults are migrated simultaneously. Each vault runs through three phases:

1. **Prepare** — Fetches all items from the source vault using batch `items.getAll()` in chunks, including fields, sections, tags, websites, notes, file attachments, and document content. Credit card expiry dates are recovered via CLI since the SDK returns them as an unsupported field type.

2. **Create** — Batch-creates items in the destination using `items.createAll()` in chunks of 100. Items with binary content (files, documents) and credit card items are created individually. Reference fields are stripped during this phase to avoid invalid ID errors.

3. **Remap references** — Maps source item IDs to destination IDs, then adds Reference fields back with the correct new IDs via `items.put()`.

### Desktop auth mode

Migration runs in two sequential phases since the SDK connects to one account at a time:

1. **Read phase** — Connects to the source account, reads all selected vault items into memory (including document binary content and credit card CLI fallbacks).
2. **Write phase** — Connects to the destination account, creates vaults and writes all items.

Personal/Private vaults are supported with desktop auth — items are written into the destination account's existing Private vault rather than creating a new one.

### Category handling

| Source category | Destination handling |
|---|---|
| Login, Secure Note, API Credential, Server, SSH Key, Software License, Database, etc. | Migrated as-is with all fields preserved |
| Credit Card | Built-in fields assigned to root section (`sectionId: ""`), card type mapped to display names, expiry recovered via CLI, section ordering enforced |
| Document | Content downloaded and re-uploaded individually |
| **Custom / Unsupported** | **Converted to Login** — username, password, and OTP detected and mapped to built-in fields; other fields placed in named sections; concealed fields remain concealed |

### What gets migrated

- All field types: Text, Concealed, TOTP, Address, SSH Key, Date, MonthYear, Email, Phone, URL, Menu, CreditCardType, CreditCardNumber, Reference
- Sections (preserved in original order)
- File attachments (binary content)
- Document content
- Tags
- Website URLs with autofill behavior
- Notes

### What does not migrate

- **Passkeys** — inaccessible via SDK, CLI, or vault export
- **Archived items** — excluded from migration

## Rate limiting

1Password allows 1,000 write API calls per hour. The tool tracks all write calls (vault creation, batch creates, individual creates, reference updates) for the duration of the session.

For service account migrations, an estimate is shown before migration starts. After completion, the banner updates with actual usage and remaining calls. If the estimate suggests the migration will exceed the limit, a confirmation dialog warns before proceeding.

Desktop auth migrations are not subject to the same API rate limits.

## Resilience

- **Retry with backoff**: Rate limits and data conflicts retry automatically (3 attempts with exponential backoff).
- **App lock detection** (desktop auth): If the 1Password app locks during migration, the tool polls every 5 seconds for up to 5 minutes, then resumes where it left off once unlocked.
- **Client disconnect**: If the browser is refreshed or closed during migration, the server continues migrating. A confirmation dialog warns before refresh.

## Debug mode

Enable verbose per-item logging via the toggle in the search bar, the environment variable `MIGRATION_DEBUG=1`, or `POST /migration/debug {"enabled": true}`.

Debug logs include full field details with automatic redaction of passwords, private keys, credit card numbers, CVVs, and other sensitive values.

## Project structure

```
├── webapp.js              # Express server — all migration logic, SDK wrapper, rate limiting
├── views/
│   ├── welcome.ejs        # Landing page — deployment method and auth mode selection
│   └── migration.ejs      # Migration UI — vault table, progress, search, logs
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## Security

- HTTPS with a self-signed TLS certificate
- Service account tokens are held in browser memory only — not persisted to disk
- `.env` tokens stay in Node.js process memory — never logged (only `✓ present` / `✗ missing`)
- All vault data (passwords, keys, files) is held in process memory during migration and released on exit
- Sensitive fields (passwords, private keys, credit card numbers) are redacted in debug logs
- No Desktop authentication using Docker — designed for local use only

## Limitations

- **Passkeys** cannot be migrated
- **Archived items** are excluded
- **Custom category items** are converted to Login
- **Vault names** are appended with "(Migrated)" in the destination (except personal vaults)
- **Personal vaults** can only be migrated with desktop auth, not service accounts
- The self-signed certificate is suitable for local use only

## Troubleshooting

- **Docker not starting**: Ensure Docker is installed and the daemon is running.
- **Connection failures**: Verify tokens have correct permissions (read for source, create for destination). For desktop auth, ensure the 1Password app is running and unlocked with both accounts signed in.
- **SSL warnings**: Expected — accept for `localhost`.
- **Rate limit errors**: The tool retries automatically. If persistent, wait an hour or contact 1Password support.
- **"Failed to convert to Item"**: Usually an unsupported field type or malformed value — check the downloaded log for the specific item.
- **Desktop auth "not authorized"**: The signed-in account name must match exactly as shown in the 1Password app sidebar.
- **`.env` not detected**: Click the reload button on the welcome page. For 1Password Environments, the read triggers an auth prompt.
