#!/usr/bin/env python3
"""Generate 1Password share links for a CSV of email/password pairs.

For each row in the input CSV, creates a Login item in 1Password, generates
a 7-day / view-once share link, then deletes the item. The output is a CSV
mapping each email address to its share link.

See README.md for setup, usage, and troubleshooting.
"""
import argparse
import asyncio
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

VERSION = "1.2.0"
SDK_VERSION = "0.4.0"
PACKAGE = "onepassword-sdk"

HERE = Path(__file__).resolve().parent
VENV = HERE / ".op_venv"
META = HERE / ".op_env_meta.json"
DOTENV = HERE / ".env"

TOKEN_KEY = "OP_SERVICE_ACCOUNT_TOKEN"
ACCOUNT_KEY = "OP_ACCOUNT"
VAULT_KEY = "OP_VAULT"
_VENV_FLAG = "_OP_VENV_ACTIVE"
_BOOTSTRAP_LOG = "_OP_BOOTSTRAP_LOG"

# Matches 1Password service-account tokens. Used to redact accidental leaks
# in the audit log. Not a substitute for being careful about what gets logged.
_TOKEN_RE = re.compile(r"ops_[A-Za-z0-9_\-]{40,}")

# Max items per create_all() call (SDK hard limit is 100).
BATCH_SIZE = 100

# Progress bar characters. Fall back to ASCII if stdout can't handle UTF-8
# (mostly a concern for older Windows terminals).
try:
    "█░".encode(sys.stdout.encoding or "utf-8")
    BAR_FULL, BAR_EMPTY = "█", "░"
except (UnicodeEncodeError, LookupError, TypeError):
    BAR_FULL, BAR_EMPTY = "#", "-"


# --- audit log --------------------------------------------------------------

class AuditLog:
    """Collects output for both the terminal and the on-disk audit log."""

    def __init__(self):
        self.lines = []
        self.started = datetime.now()

    def add(self, msg=""):
        """Append to the log without printing."""
        self.lines.append(msg)

    def write(self, msg=""):
        """Print to stdout and append to the log."""
        if "ops_" in msg:
            msg = _TOKEN_RE.sub("ops_[REDACTED]", msg)
        self.lines.append(msg)
        print(msg)

    def save(self, path):
        header = [
            "1Password Share Link Generator - Audit Log",
            f"Version:   {VERSION}",
            f"SDK:       {SDK_VERSION}",
            f"op CLI:    {op_version()}",
            f"Started:   {self.started.isoformat(timespec='seconds')}",
            f"Finished:  {datetime.now().isoformat(timespec='seconds')}",
            f"Python:    {sys.version.split()[0]}",
            f"Platform:  {sys.platform}",
            "",
            "-" * 60,
            "",
        ]
        path.write_text("\n".join(header + self.lines) + "\n", encoding="utf-8")


log = AuditLog()


def restore_bootstrap_log():
    """If the bootstrap phase passed us a log via temp file, read it in."""
    path = os.environ.pop(_BOOTSTRAP_LOG, None)
    if not path:
        return
    try:
        prior = Path(path).read_text(encoding="utf-8").splitlines()
        log.lines = prior + log.lines
    except Exception:
        pass  # not worth crashing over a log-continuity hiccup
    finally:
        Path(path).unlink(missing_ok=True)


# --- .env parsing -----------------------------------------------------------

def load_dotenv():
    """Minimal .env parser. KEY=value, quotes optional, # for comments."""
    if not DOTENV.exists():
        return
    for line in DOTENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            os.environ[key] = val


def is_op_ref(value):
    return value.strip().startswith("op://")


def is_desktop_mode():
    """True if the .env / environment specifies desktop app auth."""
    return bool(os.environ.get(ACCOUNT_KEY, "").strip())


# --- op CLI wrappers --------------------------------------------------------

def op_version():
    try:
        r = subprocess.run(
            ["op", "--version"], check=True, capture_output=True, text=True
        )
        return r.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def require_op_cli():
    try:
        subprocess.run(
            ["op", "--version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        log.write(
            "[x] 1Password CLI (`op`) not found on PATH.\n"
            "    Install: https://developer.1password.com/docs/cli/get-started/"
        )
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        log.write(f"[x] `op --version` failed: {e}")
        sys.exit(1)


def resolve_op_ref(ref):
    """Run `op inject` to resolve an op:// reference to a plaintext value.

    The reference is piped through stdin so it never appears in the process
    table. The service account token env var is unset before the call so
    the CLI uses the user's interactive session instead of trying to
    authenticate with the raw op:// string.
    """
    log.write("  [>] Resolving op:// reference via `op inject` ...")
    env = os.environ.copy()
    env.pop(TOKEN_KEY, None)
    try:
        r = subprocess.run(
            ["op", "inject"],
            input="{{ " + ref + " }}",
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    except subprocess.CalledProcessError as e:
        log.write(f"  [x] `op inject` failed: {e.stderr.strip()}")
        sys.exit(1)
    token = r.stdout.strip()
    if not token:
        log.write("  [x] `op inject` returned an empty value.")
        sys.exit(1)
    log.write("  [ok] Token resolved.")
    return token


def clear_token():
    if TOKEN_KEY in os.environ:
        del os.environ[TOKEN_KEY]


# --- venv management --------------------------------------------------------

def is_windows():
    return sys.platform.startswith("win")


def venv_python():
    return VENV / ("Scripts/python.exe" if is_windows() else "bin/python")


def venv_pip():
    return VENV / ("Scripts/pip.exe" if is_windows() else "bin/pip")


def read_meta():
    if META.exists():
        try:
            return json.loads(META.read_text())
        except Exception:
            return {}
    return {}


def write_meta(version):
    META.write_text(json.dumps({"sdk_version": version}, indent=2))


def ensure_venv():
    log.write("-- Environment -------------------------------------------------")
    meta = read_meta()
    installed = meta.get("sdk_version")
    exists = venv_python().exists()

    if exists and installed == SDK_VERSION:
        log.write(f"  [ok] SDK {SDK_VERSION} already installed, reusing venv.")
        return

    if not exists:
        log.write(f"  [>] Creating virtual environment at {VENV} ...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    else:
        log.write(
            f"  [>] SDK mismatch: installed={installed}, pinned={SDK_VERSION}. "
            f"Reinstalling."
        )

    log.write(f"  [>] Installing {PACKAGE}=={SDK_VERSION} ...")
    subprocess.run(
        [str(venv_pip()), "install", "--quiet", f"{PACKAGE}=={SDK_VERSION}"],
        check=True,
    )
    write_meta(SDK_VERSION)
    log.write(f"  [ok] SDK {SDK_VERSION} ready.")


def relaunch_in_venv():
    """Re-exec this script using the venv's Python. Passes the audit log
    accumulated so far to the child process via a temp file."""
    env = os.environ.copy()
    env[_VENV_FLAG] = "1"

    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix="op_bootstrap_log_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(log.lines))
        env[_BOOTSTRAP_LOG] = tmp_path
    except Exception:
        tmp_path = None  # not fatal, just lose log continuity

    try:
        result = subprocess.run(
            [str(venv_python()), __file__] + sys.argv[1:], env=env
        )
        sys.exit(result.returncode)
    finally:
        # clean up in case child didn't; don't leak audit log contents in /tmp
        if tmp_path and Path(tmp_path).exists():
            Path(tmp_path).unlink(missing_ok=True)


# --- bootstrap --------------------------------------------------------------

def bootstrap():
    """Pre-venv phase: load .env, resolve token (if needed), set up venv, relaunch."""
    pre_resolved = os.environ.get(TOKEN_KEY, "").strip()
    load_dotenv()

    # Service account token takes priority over desktop auth.
    if pre_resolved and not is_op_ref(pre_resolved):
        os.environ[TOKEN_KEY] = pre_resolved

    raw = os.environ.get(TOKEN_KEY, "").strip()

    if raw:
        if is_op_ref(raw):
            log.write("-- Token Resolution --------------------------------------------")
            require_op_cli()
            os.environ[TOKEN_KEY] = resolve_op_ref(raw)
        ensure_venv()
        relaunch_in_venv()
        return

    # No token — try desktop auth.
    if is_desktop_mode():
        log.write("-- Auth Mode ---------------------------------------------------")
        log.write(f"  [ok] Desktop auth: account={os.environ[ACCOUNT_KEY]}")
        ensure_venv()
        relaunch_in_venv()
        return

    log.write(
        f"[x] No authentication configured.\n"
        f"    Add one of the following to the .env file next to this script:\n"
        f"\n"
        f"    Service account (rate-limited):\n"
        f"        {TOKEN_KEY}=op://VaultName/ItemName/field\n"
        f"        {TOKEN_KEY}=ops_your_token_here\n"
        f"\n"
        f"    Desktop app auth (no rate limits, requires 1Password desktop app):\n"
        f"        {ACCOUNT_KEY}=your-account-name\n"
        f"        {VAULT_KEY}=your-vault-uuid"
    )
    sys.exit(1)


# --- CSV I/O ----------------------------------------------------------------

def read_input_csv(path):
    """Parse the input CSV. Returns a list of {email, password} dicts."""
    if not path.exists():
        log.write(f"[x] Input CSV not found: {path}")
        sys.exit(1)

    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            log.write("[x] Input CSV is empty (no header row).")
            sys.exit(1)

        lower_names = [f.lower() for f in reader.fieldnames]
        if "email" not in lower_names:
            log.write(
                f"[x] Input CSV must have an 'email' column. "
                f"Found: {reader.fieldnames}"
            )
            sys.exit(1)
        if "password" not in lower_names:
            log.write(
                f"[x] Input CSV must have a 'password' column. "
                f"Found: {reader.fieldnames}"
            )
            sys.exit(1)

        col_map = {orig: orig.lower() for orig in reader.fieldnames}
        for row in reader:
            r = {col_map[k]: v for k, v in row.items()}
            email = (r.get("email") or "").strip()
            password = (r.get("password") or "").strip()
            if not email:
                continue
            rows.append({"email": email, "password": password})

    log.write(f"  [ok] {len(rows)} row(s) loaded.")
    return rows


def write_output_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["email", "share_link"])
        w.writeheader()
        w.writerows(rows)


def write_errors_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["email", "error"])
        w.writeheader()
        w.writerows(rows)


# --- item construction ------------------------------------------------------

def login_params(email, password, vault_id):
    """Build an ItemCreateParams for a single email/password Login item.

    Imports live inside the function because the SDK isn't available before
    the venv is set up, and this function is called from run() which only
    runs inside the venv.
    """
    from onepassword import (
        ItemCategory,
        ItemCreateParams,
        ItemField,
        ItemFieldType,
    )
    return ItemCreateParams(
        title=f"Shared Login - {email}",
        category=ItemCategory.LOGIN,
        vault_id=vault_id,
        fields=[
            ItemField(
                id="username",
                title="username",
                fieldType=ItemFieldType.TEXT,
                value=email,
            ),
            ItemField(
                id="password",
                title="password",
                fieldType=ItemFieldType.CONCEALED,
                value=password,
            ),
        ],
    )


# --- arg parsing ------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description=(
            "Generate 1Password share links for a CSV of email/password "
            "pairs. See README.md for full documentation."
        )
    )
    p.add_argument(
        "--csv",
        type=Path,
        default=None,
        dest="input_csv",
        help="Path to input CSV with 'email' and 'password' columns.",
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Base directory for output. Each run creates a timestamped subfolder. Default: next to script.",
    )
    p.add_argument(
        "--vault-name",
        default=None,
        help="Vault name to use. Default: first vault the token can access.",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-item progress output.",
    )
    p.add_argument(
        "--no-verify",
        action="store_true",
        help=(
            "Skip email verification. By default, recipients must verify "
            "their email address before viewing the shared item. This flag "
            "makes links accessible to anyone."
        ),
    )
    p.add_argument(
        "--clean",
        action="store_true",
        help="Remove the .op_venv directory and .op_env_meta.json.",
    )
    p.add_argument(
        "--version",
        action="version",
        version=f"share_links.py {VERSION} (SDK {SDK_VERSION})",
    )
    return p.parse_args()


# --- main run ---------------------------------------------------------------


async def run(args):
    from onepassword.client import Client
    from onepassword import ItemShareDuration, ItemShareParams

    output_dir = (args.output_dir or HERE).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    log.write("")
    log.write("-- Input CSV ---------------------------------------------------")
    input_rows = read_input_csv(args.input_csv.resolve())
    if not input_rows:
        log.write("  [!] No rows to process. Exiting.")
        return 0

    # --- Authenticate (desktop app or service account) ------------------

    log.write("")
    log.write("-- Authentication ----------------------------------------------")

    desktop_account = os.environ.get(ACCOUNT_KEY, "").strip()
    desktop_vault = os.environ.get(VAULT_KEY, "").strip()

    if desktop_account:
        from onepassword.client import DesktopAuth
        try:
            client = await Client.authenticate(
                auth=DesktopAuth(account_name=desktop_account),
                integration_name="1Password Share Link Generator",
                integration_version=f"v{VERSION}",
            )
        except Exception as e:
            log.write(f"  [x] Desktop auth failed: {e}")
            log.write("      Make sure the 1Password desktop app is open and unlocked,")
            log.write("      and SDK integration is enabled in Settings > Developer.")
            return 2
        log.write(f"  [ok] Authenticated via desktop app (account: {desktop_account}).")
    else:
        token = os.environ.get(TOKEN_KEY, "").strip()
        try:
            client = await Client.authenticate(
                auth=token,
                integration_name="1Password Share Link Generator",
                integration_version=f"v{VERSION}",
            )
        except Exception as e:
            log.write(f"  [x] Authentication failed: {e}")
            return 2
        log.write("  [ok] Authenticated via service account.")

    # --- Vault discovery ------------------------------------------------

    log.write("")
    log.write("-- Vault Discovery ---------------------------------------------")

    desktop_vault_id = desktop_vault if desktop_account else None

    try:
        vaults = list(await client.vaults.list())
    except Exception as e:
        log.write(f"  [x] Could not list vaults: {e}")
        return 2
    if not vaults:
        log.write("  [!] No vaults found. Check account access.")
        return 2

    vault = None
    if desktop_vault_id:
        for v in vaults:
            if v.id == desktop_vault_id:
                vault = v
                break
        if vault is None:
            log.write(f"  [x] Vault ID '{desktop_vault_id}' not found in account.")
            available = ", ".join(f"{v.title} ({v.id})" for v in vaults[:10])
            log.write(f"      Available: {available}")
            return 2
    elif args.vault_name:
        for v in vaults:
            if v.title.lower() == args.vault_name.lower():
                vault = v
                break
        if vault is None:
            available = ", ".join(v.title for v in vaults)
            log.write(f"  [x] Vault '{args.vault_name}' not found.")
            log.write(f"      Available: {available}")
            return 2
    else:
        vault = vaults[0]

    log.write(f"  [ok] Using vault: {vault.title} ({vault.id})")

    # --- Phase 1: create items in batches of up to 100 ------------------

    log.write("")
    log.write("-- Phase 1: Creating Items -------------------------------------")

    total = len(input_rows)
    batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    log.write(f"  [>] {total} item(s) in {batches} batch(es) of up to {BATCH_SIZE}.")

    items_by_id = {}   # item_id -> (Item, row dict)
    failed = []        # [{"email", "error"}]
    errors = 0

    for b in range(batches):
        chunk = input_rows[b * BATCH_SIZE : (b + 1) * BATCH_SIZE]
        msg = f"  Batch {b + 1}/{batches}: {len(chunk)} item(s) ..."
        if not args.quiet:
            print(msg, end=" ", flush=True)
        log.add(msg)

        try:
            params = [login_params(r["email"], r["password"], vault.id) for r in chunk]
            resp = await client.items.create_all(vault.id, params)

            ok_count = 0
            for i, ir in enumerate(resp.individual_responses):
                row = chunk[i]
                if ir.error is not None:
                    errors += 1
                    failed.append({"email": row["email"], "error": str(ir.error)})
                    log.add(f"    -> [create error] {row['email']}: {ir.error}")
                else:
                    # Keep the Item object itself — shares.create() needs it,
                    # so this saves us a round-trip per item in Phase 2.
                    items_by_id[ir.content.id] = (ir.content, row)
                    ok_count += 1

            done = f"done ({ok_count}/{len(chunk)} created)"
            if not args.quiet:
                print(done)
            log.add(f"    -> {done}")
        except Exception as e:
            em = str(e)
            if not args.quiet:
                print(f"batch error: {em}")
            log.add(f"    -> batch error: {em}")
            for row in chunk:
                errors += 1
                failed.append({"email": row["email"], "error": em})

    created_ids = list(items_by_id.keys())
    log.write(f"  [ok] {len(created_ids)}/{total} created, {errors} error(s).")

    # --- Phase 2: generate share links, delete items --------------------

    results = []  # [{"email", "share_link"}]
    remaining = set(created_ids)  # item IDs still live in the vault
    interrupted = False

    async def cleanup_remaining():
        """Delete any items that haven't been shared-and-deleted yet.
        Called on both normal errors and Ctrl+C."""
        if not remaining:
            return
        log.write("")
        log.write(f"  [!] Cleaning up {len(remaining)} item(s) before exit ...")
        for item_id in list(remaining):
            try:
                await client.items.delete(vault.id, item_id)
                remaining.discard(item_id)
            except Exception as ce:
                log.add(f"    -> could not delete {item_id}: {ce}")
        log.write(f"  [ok] Cleanup done. {len(remaining)} orphan(s) remain.")

    try:
        if not created_ids:
            log.write("")
            log.write("  [!] No items created; skipping Phase 2.")
        else:
            log.write("")
            log.write("-- Phase 2: Generating Share Links -----------------------------")

            # Account sharing policy is account-wide, fetch it once.
            # Reuse the first cached Item instead of an extra get() call.
            first_item, _ = items_by_id[created_ids[0]]
            try:
                policy = await client.items.shares.get_account_policy(
                    first_item.vault_id, first_item.id
                )
                log.write("  [ok] Account sharing policy fetched.")
            except Exception as e:
                log.write(f"  [x] Could not fetch sharing policy: {e}")
                await cleanup_remaining()
                return 2

            log.write(f"  [>] Generating {len(created_ids)} share link(s) ...")
            if args.no_verify:
                log.write("  [>] Email verification: OFF (--no-verify)")
            else:
                log.write("  [>] Email verification: ON (recipients must confirm email)")

            # Estimate: ~1.5s per item (0.5s buffer + API latency).
            est_minutes = (len(created_ids) * 1.5) / 60
            if est_minutes < 1:
                log.write(f"  [>] Estimated time: ~{int(est_minutes * 60)}s")
            else:
                log.write(f"  [>] Estimated time: ~{est_minutes:.1f} min")

            for seq, item_id in enumerate(created_ids, start=1):
                item, row = items_by_id[item_id]
                email = row["email"]
                log.add(f"  [{seq}/{len(created_ids)}] {email}")

                if not args.quiet:
                    filled = int((seq / len(created_ids)) * 20)
                    bar = BAR_FULL * filled + BAR_EMPTY * (20 - filled)
                    remaining_secs = int((len(created_ids) - seq) * 1.5)
                    mins, secs = divmod(remaining_secs, 60)
                    eta = f"{mins}m{secs:02d}s" if mins else f"{secs}s"
                    print(
                        f"\r  [{bar}] {seq}/{len(created_ids)}  "
                        f"~{eta} left  {email:<35}",
                        end="",
                        flush=True,
                    )

                try:
                    # Default: validate the recipient email so they must
                    # confirm ownership before viewing the shared item.
                    if args.no_verify:
                        recipients = []
                    else:
                        recipients = await client.items.shares.validate_recipients(
                            policy, [email]
                        )

                    link = await client.items.shares.create(
                        item,
                        policy,
                        ItemShareParams(
                            expireAfter=ItemShareDuration.SEVENDAYS,
                            oneTimeOnly=True,
                            recipients=recipients,
                        ),
                    )
                    await client.items.delete(vault.id, item_id)
                    remaining.discard(item_id)
                    results.append({"email": email, "share_link": link})
                    log.add(f"    -> done: {email}")
                except Exception as e:
                    em = str(e)
                    if not args.quiet:
                        print(f"\r  [!] {email}: {em}{' ' * 20}", flush=True)
                    log.add(f"    -> error: {email}: {em}")
                    errors += 1
                    failed.append({"email": email, "error": em})
                    # Try to delete the item anyway so credentials don't linger.
                    try:
                        await client.items.delete(vault.id, item_id)
                        remaining.discard(item_id)
                        log.add(f"    -> cleaned up item {item_id}")
                    except Exception as ce:
                        log.add(f"    -> orphan {item_id}: {ce}")

                # Half-second buffer between shares to stay under the
                # 60 shares/min rate limit (~40/min actual throughput).
                if seq < len(created_ids):
                    await asyncio.sleep(0.5)

            if not args.quiet:
                bar = BAR_FULL * 20
                print(
                    f"\r  [{bar}] {len(created_ids)}/{len(created_ids)}  done"
                    f"{' ' * 40}"
                )
    except KeyboardInterrupt:
        interrupted = True
        print("\n  [!] Interrupted. Cleaning up, please wait ...", flush=True)
        log.add("  [!] Interrupted by user (Ctrl+C).")
        try:
            await cleanup_remaining()
        except KeyboardInterrupt:
            # Second Ctrl+C — give up on cleanup; log the orphans.
            log.write("  [!] Second Ctrl+C received. Giving up on cleanup.")
            log.write(f"  [!] {len(remaining)} item(s) may be left in the vault:")
            for item_id in remaining:
                log.write(f"        {item_id}")

    # --- Output files ---------------------------------------------------

    log.write("")
    log.write("-- Writing Output ----------------------------------------------")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_dir / f"run_{ts}"
    run_dir.mkdir(parents=True, exist_ok=True)

    csv_path = run_dir / "share_links.csv"
    log_path = run_dir / "audit.log"
    err_path = run_dir / "errors.csv"

    if results:
        write_output_csv(csv_path, results)
        log.write(f"  [ok] {len(results)} share link(s) -> {csv_path}")
    else:
        log.write("  [!] No share links generated.")

    if failed:
        write_errors_csv(err_path, failed)
        log.write(f"  [!] {errors} error(s) -> {err_path}")

    log.write("")
    log.write("-- Complete ----------------------------------------------------")
    log.write(f"  [ok] {len(results)}/{total} processed successfully.")
    if interrupted:
        log.write("  [!] Run was interrupted.")
    if errors:
        log.write(f"  [!] {errors} row(s) failed.")

    log.save(log_path)
    log.write(f"  [ok] Audit log -> {log_path}")

    if interrupted:
        return 130
    return 1 if errors else 0


# --- entry point ------------------------------------------------------------
#
# Exit codes:
#   0   - all rows processed successfully
#   1   - some rows failed (see .errors file)
#   2   - fatal error (auth, permissions, no vault)
#   130 - interrupted by Ctrl+C during run

if __name__ == "__main__":
    args = parse_args()

    if args.clean and args.input_csv:
        # Both provided: run first, clean after.
        do_clean_after = True
        print("  [>] Will clean up venv after run.")
    elif args.clean:
        # --clean only: clean and exit.
        import shutil
        removed = []
        if VENV.exists():
            shutil.rmtree(VENV)
            removed.append(str(VENV))
        if META.exists():
            META.unlink()
            removed.append(str(META))
        if removed:
            print(f"Removed: {', '.join(removed)}")
        else:
            print("Nothing to clean.")
        sys.exit(0)
    else:
        do_clean_after = False

    if not args.input_csv:
        print("Error: --csv is required. Run with --help for usage.")
        sys.exit(1)

    in_venv = bool(os.environ.get(_VENV_FLAG))

    if not in_venv:
        load_dotenv()

    has_token = bool(os.environ.get(TOKEN_KEY, "").strip())
    token_plaintext = has_token and not is_op_ref(os.environ.get(TOKEN_KEY, ""))

    if in_venv:
        restore_bootstrap_log()
        try:
            code = asyncio.run(run(args))
        finally:
            clear_token()
            if do_clean_after:
                import shutil
                removed = []
                if VENV.exists():
                    shutil.rmtree(VENV)
                    removed.append(str(VENV))
                if META.exists():
                    META.unlink()
                    removed.append(str(META))
                if removed:
                    print(f"Cleaned up: {', '.join(removed)}")
        sys.exit(code)
    elif token_plaintext:
        ensure_venv()
        relaunch_in_venv()
    elif has_token:
        # Token is an op:// reference — needs bootstrap to resolve it.
        bootstrap()
    elif is_desktop_mode():
        vault_id = os.environ.get(VAULT_KEY, "").strip()
        if not vault_id:
            log.write(
                f"[x] {VAULT_KEY} is required when using desktop auth.\n"
                f"    Add it to your .env file:\n"
                f"        {ACCOUNT_KEY}=your-account-name\n"
                f"        {VAULT_KEY}=your-vault-uuid"
            )
            sys.exit(1)
        ensure_venv()
        relaunch_in_venv()
    else:
        bootstrap()