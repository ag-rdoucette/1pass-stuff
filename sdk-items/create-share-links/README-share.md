# 1Password Share Link Generator

Takes a CSV of email/password pairs, creates a Login item in 1Password for each one, generates a **7-day / view-once share link** for each item, then deletes the item. The output is a second CSV mapping each email address to its corresponding share link.

This is useful for bulk-provisioning credentials to users (new hires, contractors, customers) without ever exposing plaintext passwords in email or chat — the share link is a one-time URL, and the 1Password item is deleted immediately after the link is generated.

## How it works

For each row in your input CSV:

1. Creates a 1Password Login item (username = email, password = concealed) — done in batches of up to 100
2. Generates a share link (7-day expiry, view-once, no recipient restriction)
3. Deletes the 1Password item
4. Writes `email,share_link` to the output CSV

At the end you get a CSV mapping every email to its link, which you can then distribute however you like (email, Slack, ticketing system, etc.). Only the person who opens the link first will see the credentials — after that, the link is dead.

## Requirements

- Python 3.9 or later
- A 1Password account with access to a vault for temporary item creation

For **service account** auth (Options A/B), you also need:
- The 1Password CLI (`op`) on your `PATH` — [install instructions](https://developer.1password.com/docs/cli/get-started/)
- A service account with `Read, Write & Share` permission on the target vault

For **desktop app** auth (Option C), you need:
- The 1Password desktop app installed, open, and unlocked

The Python SDK, virtual environment, and all other dependencies are installed automatically the first time you run the script.

## One-time setup

Steps 1 and 2 are only needed for service account auth (Options A/B). If you're using desktop app auth (Option C), skip to step 3.

### 1. Create a dedicated vault

Create an empty vault in 1Password specifically for this tool. Don't use an existing vault — the service account should only have access to this one vault.

### 2. Create the service account

1. Sign in to 1Password.com
2. Go to **Developer** → **Service Account**
3. Name it something descriptive like `Share Link Generator`
4. When prompted for vault access, select **only the vault you created in step 1**
5. Set the permission to **Read, Write & Share**
   > **Important:** After selecting permissions in the dropdown, click outside the box before saving. 1Password's UI has a known bug where permissions silently revert if you don't click away first.
6. Save the service account token somewhere safe — you'll need it in the next step

### 3. Store the token

Two options. The op:// reference method is strongly recommended.

**Option A: op:// reference (recommended for service accounts)**

Store the token inside 1Password as an item, then reference it. The plaintext token never touches disk.

Create a file named `.env` in the **same directory as the script** containing:

```
OP_SERVICE_ACCOUNT_TOKEN=op://YourVaultName/YourItemName/credential
```

Replace `YourVaultName`, `YourItemName`, and `credential` with the vault and item in your personal 1Password account where you saved the token. The script calls `op inject` to resolve this reference at runtime using your interactive `op` CLI session.

Before running the script, sign in to `op` interactively:

```
op signin
```

**Option B: plaintext fallback**

Create a `.env` file next to the script containing:

```
OP_SERVICE_ACCOUNT_TOKEN=ops_your_token_here
```

This works without `op signin`, but the plaintext token lives on disk. Only use this approach for testing, CI/CD where Option A isn't practical, or non-interactive scheduled runs.

**Option C: Desktop app auth (no rate limits)**

If you're hitting service account rate limits, you can authenticate directly through the 1Password desktop app instead. This uses your personal account and has no API rate limits.

Create a `.env` file next to the script containing:

```
OP_ACCOUNT=your-account-name
OP_VAULT=tu4wy6yyujlqq3vymsyfoee4jq
```

`OP_ACCOUNT` is your 1Password account name as it appears at the top of the sidebar in the 1Password desktop app. `OP_VAULT` is the UUID of the vault to use — you can find it by running `op vault list` or in the vault's URL on 1Password.com.

Requirements for desktop auth:
- The 1Password desktop app must be open and unlocked
- Go to **Settings > Developer** and enable **Integrate with other apps**
- For biometric auth, also enable Touch ID / Windows Hello in **Settings > Security**

When you run the script, the 1Password app will prompt you to authorize the connection. The authorization lasts 10 minutes of inactivity.

## Input CSV format

Two columns required: `email` and `password`. Column names are case-insensitive. Extra columns are ignored.

```
email,password
alice@example.com,hunter2
bob@example.com,correct-horse-battery-staple
carol@example.com,tr0ub4dor&3
```

## Running the script

Simplest invocation:

```
python share_links.py --csv credentials.csv
```

With optional flags:

```
# Write outputs to a specific folder
python share_links.py --csv credentials.csv --output-dir ./results

# Pin to a specific vault by name (not normally needed)
python share_links.py --csv credentials.csv --vault-name "My Vault"

# Suppress per-item progress output
python share_links.py --csv credentials.csv --quiet

# Remove the virtual environment and metadata only
python share_links.py --clean

# Run, then clean up the venv and metadata afterwards
python share_links.py --csv credentials.csv --clean
```

On the first run the script will:

1. Resolve your service account token via `op inject` (if using op:// reference)
2. Create a virtual environment at `.op_venv/` next to the script
3. Install the 1Password Python SDK
4. Re-launch itself inside the venv and execute the task

Subsequent runs skip the venv setup.

## Output files

Everything is written to `./runs/` next to the script (or wherever `--output-dir` points):

- `share_links_<timestamp>.csv` — the email → share link mapping
- `share_links_<timestamp>.log` — full audit log of the run
- `share_links_<timestamp>.errors` — rows that failed (only created if there are errors)

A typical output CSV looks like:

```
email,share_link
alice@example.com,https://share.1password.com/s#abc123...
bob@example.com,https://share.1password.com/s#def456...
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | All rows processed successfully |
| 1    | Some rows failed — see the `.errors` file |
| 2    | Fatal error (authentication, permissions, no vault) |
| 130  | Interrupted by Ctrl+C during run |

Useful for scripting and CI. A typical wrapper script might check for exit code 0 only, or treat 1 and 0 as "partial success" and anything higher as a hard failure.

## Interrupt handling

If you press Ctrl+C during a run, the script will:

1. Stop starting new share link operations
2. Delete any items that were created but haven't been shared and deleted yet
3. Write partial results to the output CSV (for items that did complete)
4. Exit with code 130

This means Ctrl+C is safe — you won't end up with stale items in the vault containing plaintext passwords. If the cleanup itself fails (network issue, etc.) the audit log will list the item IDs that were left behind so you can manually delete them.

If you press Ctrl+C a second time while cleanup is running, the script gives up immediately and logs the remaining item IDs to the audit log. You'll need to delete those items manually from 1Password before re-running.

## Sharing the links

Copy the links and distribute them however makes sense for your workflow — email, Slack, your ticketing system. Each link can only be opened once, expires after 7 days, and contains a copy of the credentials rather than a reference to them, so the 1Password vault can be fully emptied without breaking anything.

If a link is never opened, the credentials inside it are effectively destroyed after 7 days.

## Troubleshooting

**"not sufficient permissions for the item update operation"**
Your service account doesn't have full write access on the target vault. Go back to 1Password.com, delete the service account, and create a new one — this time make sure to click outside the permissions dropdown before saving (UI bug workaround).

**"op inject failed"**
You haven't signed in to `op` yet in this terminal session. Run `op signin` and try again.

**"1Password CLI (op) was not found on PATH"**
Install the 1Password CLI from [developer.1password.com/docs/cli/get-started](https://developer.1password.com/docs/cli/get-started/). On macOS: `brew install 1password-cli`. On Linux: follow the apt/yum instructions.

**Share link creation fails with a permissions error**
The service account was created without the Share Items permission. Service accounts need this specific permission to generate share links — it's included in `Read, Write & Share` but can be missed if you selected permissions granularly.

**"data conflict occurred on the server"**
This happens when too many concurrent operations hit the same vault. The script processes share links one at a time to avoid this, so if you see it it's likely a transient issue — just re-run. Failed items are reported in the `.errors` file; re-run with only those rows.

**Hidden files cluttering the script directory**
The `.op_venv/`, `.op_env_meta.json`, and `.env` files are intentionally placed next to the script. They're dotfiles so they're hidden by default in Finder (press `Cmd+Shift+.` on macOS to toggle). If you want the script directory clean, put the script in its own folder.

**"Desktop auth failed"**
Make sure the 1Password desktop app is open and unlocked, and that SDK integration is enabled in Settings > Developer > "Integrate with other apps". Check that `OP_ACCOUNT` in your `.env` matches the account name shown at the top of the 1Password app sidebar exactly.

**Progress bar looks like garbage in Windows cmd.exe**
The script auto-detects whether your terminal supports UTF-8 and falls back to ASCII characters if not. If you still see issues, try running in Windows Terminal or PowerShell — both handle UTF-8 by default.

## Security notes

- The plaintext service account token only exists in memory for the duration of the script run. It is never written to disk (when using the op:// reference method) and is cleared from the process environment at the end of the run.
- 1Password items created by the script contain the plaintext password. They exist in the vault for the duration of Phase 2 (typically seconds to a few minutes depending on how many rows are in the input CSV) and are deleted after the share link is generated.
- The `.errors` file contains email addresses but **not** passwords. Share links in the output CSV contain the credentials as embedded content and should be treated as sensitive until the links are used or expire.
- The audit log redacts any string matching the service account token pattern as a defense-in-depth safety net.
- Pressing Ctrl+C triggers a cleanup pass so items don't linger in the vault after an abort.

## What if something goes wrong mid-run?

If the script fails partway through:

1. The items that were successfully shared **have already been deleted** from the vault
2. Any items that failed during share link creation should be cleaned up automatically
3. If the script is killed by a system crash (not Ctrl+C), some items may be left behind in the vault — open the vault in 1Password and delete them manually before re-running
4. To resume: create a new input CSV containing only the rows from the `.errors` file, then run the script against that CSV

Share links from successful rows are final — they can't be regenerated. If you lose the output CSV before distributing the links, re-run the script with the same input CSV to generate fresh links.

## Performance expectations

1Password enforces a rate limit of 60 item shares per minute per account. The script adds a half-second buffer between each share to stay safely under this limit (~40 shares per minute actual throughput).

Approximate run times:

| Rows | Phase 1 (create) | Phase 2 (share + delete) | Total |
|------|-------------------|--------------------------|-------|
| 50   | ~2s               | ~1 min                   | ~1.5 min |
| 100  | ~3s               | ~2.5 min                 | ~3 min |
| 500  | ~10s              | ~12.5 min                | ~13 min |
| 1000 | ~20s              | ~25 min                  | ~25 min |

The script shows a progress bar with a live ETA countdown during Phase 2 so you can see exactly how long is left.