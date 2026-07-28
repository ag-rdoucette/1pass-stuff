# 1Password Login Items Report

A Python script that reads 1Password vaults, pulls all Login items, and writes them to a timestamped CSV with a matching audit log.

Runs on Windows and macOS. Self-bootstraps its own virtual environment on first run. Pinned to a specific SDK version for reproducibility.

## What gets exported

For every Login item in every scanned vault, the CSV contains one row with the following columns:

| Column | Source |
|---|---|
| `vault_uuid` | Vault ID |
| `vault_name` | Vault title |
| `title` | Item title |
| `username` | The item's username field |
| `website_1` ... `website_N` | Autofill website URLs on the item |
| `url_1` ... `url_N` | Any explicit Url-type fields on the item |
| `tags` | Comma-separated list of tags |
| `notes` | Item notes |

The `website_N` and `url_N` column counts are computed from the whole dataset. Items with fewer values get empty strings in the extra columns.

## What does NOT get exported

By design, the CSV does not include:

- Passwords
- TOTP secrets
- API credentials or private keys
- Attached files
- Any custom fields not listed in the column table above
- Non-Login items (Secure Notes, Credit Cards, Identities, etc.)

## Requirements

- Python 3.9 or later

For **service account** auth (Options A/B), you also need:
- The 1Password CLI (`op`) on your `PATH` — [install instructions](https://developer.1password.com/docs/cli/get-started/)
- A service account with **read** access to the vaults you want in the report

For **desktop app** auth (Option C), you need:
- The 1Password desktop app installed, open, and unlocked

The Python SDK, virtual environment, and all other dependencies are installed automatically the first time you run the script.

## Setup

### 1. Install the 1Password CLI

Only needed for service account auth. Skip this if using desktop app auth.

On macOS:

```
brew install 1password-cli
```

On Windows:

```
winget install 1password-cli
```

Then sign in once:

```
op signin
```

### 2. Create the service account

Only needed for service account auth. Skip this if using desktop app auth.

In the 1Password web UI, create a service account with **read** access to the vaults you want in the report. Save the token in a 1Password item so you can reference it via `op://`.

### 3. Configure the `.env` file

Create a file called `.env` in the **same directory as the script**. Choose one of the following options.

**Option A: op:// reference (recommended for service accounts)**

```
OP_SERVICE_ACCOUNT_TOKEN="op://VaultName/ItemName/credential"
```

The script calls `op inject` to resolve this at runtime. Requires `op signin` first.

**Option B: plaintext fallback**

```
OP_SERVICE_ACCOUNT_TOKEN=ops_your_token_here
```

Works without `op signin`, but the token lives on disk. Use for testing or CI/CD only.

**Option C: Desktop app auth (no rate limits)**

```
OP_ACCOUNT=your-account-name
OP_VAULTS=vault-uuid-1,vault-uuid-2
```

`OP_ACCOUNT` is your 1Password account name as shown at the top of the sidebar in the desktop app. `OP_VAULTS` is a comma-separated list of vault UUIDs to scan. You can find vault UUIDs by running `op vault list` or in the vault's URL on 1Password.com.

You can specify one vault or many:

```
# Single vault
OP_ACCOUNT="My Company"
OP_VAULTS=tu4wy6yyujlqq3vymsyfoee4jq

# Multiple vaults
OP_ACCOUNT="My Company"
OP_VAULTS=tu4wy6yyujlqq3vymsyfoee4jq,f77xsfe2mchjtkmodnh2ihbu3m,abc123def456ghi
```

Requirements for desktop auth:
- The 1Password desktop app must be open and unlocked
- Go to **Settings > Developer** and enable **Integrate with other apps**
- For biometric auth, enable Touch ID / Windows Hello in **Settings > Security**

With service account auth, the script scans all vaults the service account has access to. With desktop auth, it scans only the vaults listed in `OP_VAULTS`.

## Usage

### Basic run

```
python items_report.py
```

On first run the script creates a `.op_venv/` directory, installs the 1Password SDK, and re-launches itself inside the venv. Subsequent runs skip the install.

### Output location

By default, output goes to `./runs/` next to the script:

```
python items_report.py --output-dir /path/to/reports
```

### Quiet mode

```
python items_report.py --quiet
```

The audit log still captures everything.

### Clean up

Remove the virtual environment and metadata file:

```
python items_report.py --clean
```

### Version

```
python items_report.py --version
```

## Output files

Every run produces files in the output directory with a shared timestamp:

```
items_report_20260418_143055.csv      <- the report
items_report_20260418_143055.log      <- the audit log
items_report_20260418_143055.errors   <- only present if items failed
```

### The CSV

One row per Login item. See the column table at the top of this README.

### The audit log

Captures every line printed during the run, plus a header with script version, SDK version, Python version, platform, and timestamps.

### The errors file

Only written if one or more items failed to fetch. CSV with columns `failure_type`, `vault_uuid`, `vault_name`, `item_id`, `error`.

| `failure_type` | Meaning |
|---|---|
| `item` | A specific item failed. Worth investigating. |
| `batch` | A batch of 50 items failed together (network issue, SDK exception). Re-run to see which ones still fail. |
| `vault_listing` | Couldn't list items in a vault at all. Check vault permissions. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Complete success. CSV written, no errors. |
| 1 | CSV written, but some items failed. Check the `.errors` file. |
| 2 | Fatal error. Authentication or vault listing failed. No CSV written. |

## Verifying your first run

Before relying on the CSV for anything, spot-check the output:

1. Pick five rows from the CSV at random, covering different vaults if possible
2. Open each item in 1Password and compare username, websites, URLs, tags, and notes
3. Check the row count is plausible
4. Review the audit log for skipped items, even if the exit code was 0

## Updating the SDK

The SDK version is pinned to `0.4.0` in the script. To update:

1. Change `SDK_VERSION` in `items_report.py`
2. Run `python items_report.py --clean`
3. The next run will install the new version

## Troubleshooting

**"1Password CLI (op) was not found on PATH"**
Install the CLI and make sure it's on PATH for the user running the script.

**"op inject failed"**
Run `op signin` first. If running as a scheduled task, the task's user needs their own session.

**"Desktop auth failed"**
Make sure the 1Password desktop app is open and unlocked, and SDK integration is enabled in Settings > Developer > "Integrate with other apps". Check that `OP_ACCOUNT` matches the account name in the app sidebar exactly.

**"Vault ID not found in account"**
The UUID in `OP_VAULTS` doesn't match any vault in the account. Run `op vault list` to find the correct UUIDs.

**"No vaults returned"**
The service account has no vault access. Grant it read access in the 1Password web UI.

**Items fail to fetch in bulk**
The script fetches in batches of 50. If a batch errors out, all 50 IDs appear in the `.errors` file. Usually a transient issue — re-run.

**The venv seems broken**
Run `python items_report.py --clean` and the next run will rebuild it.

## `.env` file format

- One `KEY=value` per line
- Blank lines and lines starting with `#` are ignored
- Optional surrounding quotes on the value are stripped
- Everything after the first `=` is the value

Not supported: `export` prefixes, shell escapes, variable interpolation, multi-line values.

## Files produced by the script

| Path | What it is | Safe to delete? |
|---|---|---|
| `.op_venv/` | Virtual environment with the pinned SDK | Yes — `--clean` or delete manually. Rebuilt on next run. |
| `.op_env_meta.json` | Records the installed SDK version | Yes — `--clean` or delete manually. |
| `runs/items_report_*.csv` | Report output | Archive first if needed. |
| `runs/items_report_*.log` | Audit log | Keep for audit retention. |
| `runs/items_report_*.errors` | Per-item error details | Keep with the matching log. |

## Security notes

- The script never writes the service account token to disk. It lives in process memory for the duration of the run.
- The token is removed from `os.environ` after the export completes.
- The `op://` reference is passed to the CLI via stdin, not argv — it does not appear in `ps` or Task Manager.
- The CSV contains usernames, URLs, tags, and notes.
- Desktop app auth does not use a service account token at all — authentication happens through the 1Password app via a local IPC channel.