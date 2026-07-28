#!/usr/bin/env python3
"""Export Login items from 1Password vaults to a timestamped CSV.

Reads every vault the service account can access (or specific vaults via
desktop app auth), pulls all Login items, and writes them to a CSV with
a matching audit log.

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

SCRIPT_VERSION = "1.0.0"
SDK_VERSION = "0.4.0"
PACKAGE = "onepassword-sdk"

HERE = Path(__file__).resolve().parent
VENV = HERE / ".op_venv"
META = HERE / ".op_env_meta.json"
DOTENV = HERE / ".env"

# The SDK's get_all() accepts up to 50 item IDs per call.
BATCH_SIZE = 50

TOKEN_KEY = "OP_SERVICE_ACCOUNT_TOKEN"
ACCOUNT_KEY = "OP_ACCOUNT"
VAULTS_KEY = "OP_VAULTS"
_VENV_FLAG = "_OP_VENV_ACTIVE"
_BOOTSTRAP_LOG = "_OP_BOOTSTRAP_LOG"

_TOKEN_RE = re.compile(r"ops_[A-Za-z0-9_\-]{40,}")


# --- audit log --------------------------------------------------------------

class AuditLog:
    def __init__(self):
        self.lines = []
        self.started = datetime.now()

    def add(self, msg=""):
        self.lines.append(msg)

    def write(self, msg=""):
        if "ops_" in msg:
            msg = _TOKEN_RE.sub("ops_[REDACTED]", msg)
        self.lines.append(msg)
        print(msg)

    def save(self, path):
        header = [
            "1Password Items Report - Audit Log",
            f"Version:   {SCRIPT_VERSION}",
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
    path = os.environ.pop(_BOOTSTRAP_LOG, None)
    if not path:
        return
    try:
        prior = Path(path).read_text(encoding="utf-8").splitlines()
        log.lines = prior + log.lines
    except Exception:
        pass
    finally:
        Path(path).unlink(missing_ok=True)


# --- .env parsing -----------------------------------------------------------

def load_dotenv():
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
    return bool(os.environ.get(ACCOUNT_KEY, "").strip())


def parse_vault_ids():
    """Parse OP_VAULTS from env. Supports comma-separated UUIDs."""
    raw = os.environ.get(VAULTS_KEY, "").strip()
    if not raw:
        return []
    return [v.strip() for v in raw.split(",") if v.strip()]


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
    env = os.environ.copy()
    env[_VENV_FLAG] = "1"

    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix="op_bootstrap_log_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(log.lines))
        env[_BOOTSTRAP_LOG] = tmp_path
    except Exception:
        tmp_path = None

    try:
        result = subprocess.run(
            [str(venv_python()), __file__] + sys.argv[1:], env=env
        )
        sys.exit(result.returncode)
    finally:
        if tmp_path and Path(tmp_path).exists():
            Path(tmp_path).unlink(missing_ok=True)


# --- bootstrap --------------------------------------------------------------

def bootstrap():
    pre_resolved = os.environ.get(TOKEN_KEY, "").strip()
    load_dotenv()

    # Service account token takes priority over desktop auth.
    if pre_resolved and not is_op_ref(pre_resolved):
        os.environ[TOKEN_KEY] = pre_resolved

    raw = os.environ.get(TOKEN_KEY, "").strip()

    if raw:
        # Have a token — resolve it if it's an op:// reference.
        if is_op_ref(raw):
            log.write("-- Token Resolution --------------------------------------------")
            require_op_cli()
            os.environ[TOKEN_KEY] = resolve_op_ref(raw)
        ensure_venv()
        relaunch_in_venv()
        return

    # No token — try desktop auth.
    if is_desktop_mode():
        vault_ids = parse_vault_ids()
        if not vault_ids:
            log.write(
                f"[x] {VAULTS_KEY} is required when using desktop auth.\n"
                f"    Add it to your .env file:\n"
                f"        {ACCOUNT_KEY}=your-account-name\n"
                f"        {VAULTS_KEY}=vault-uuid-1,vault-uuid-2"
            )
            sys.exit(1)
        log.write("-- Auth Mode ---------------------------------------------------")
        log.write(f"  [ok] Desktop auth: account={os.environ[ACCOUNT_KEY]}")
        log.write(f"  [ok] Vault(s): {', '.join(vault_ids)}")
        ensure_venv()
        relaunch_in_venv()
        return

    # Neither configured.
    log.write(
        f"[x] No authentication configured.\n"
        f"    Add one of the following to the .env file next to this script:\n"
        f"\n"
        f"    Service account:\n"
        f"        {TOKEN_KEY}=op://VaultName/ItemName/field\n"
        f"        {TOKEN_KEY}=ops_your_token_here\n"
        f"\n"
        f"    Desktop app auth:\n"
        f"        {ACCOUNT_KEY}=your-account-name\n"
        f"        {VAULTS_KEY}=vault-uuid-1,vault-uuid-2"
    )
    sys.exit(1)


# --- item helpers -----------------------------------------------------------

def field_value(item, field_id):
    for f in (item.fields or []):
        if f.id == field_id or f.title.lower() == field_id.lower():
            return (f.value or "").strip()
    return ""


def website_urls(item):
    seen, urls = set(), []
    for site in (item.websites or []):
        v = (site.url or "").strip()
        if v and v not in seen:
            urls.append(v)
            seen.add(v)
    return urls


def url_fields(item):
    seen, urls = set(), []
    for f in (item.fields or []):
        if f.field_type == "Url":
            v = (f.value or "").strip()
            if v and v not in seen:
                urls.append(v)
                seen.add(v)
    return urls


def item_notes(item):
    if hasattr(item, "notes") and item.notes:
        return item.notes.strip()
    for f in (item.fields or []):
        if f.field_type == "Notes" and f.value:
            return f.value.strip()
    return ""


def item_tags(item):
    return ", ".join(item.tags or [])


def is_login(item):
    return "LOGIN" in str(getattr(item, "category", "")).upper()


def chunks(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i : i + size]


def write_errors(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(
            fh,
            fieldnames=["failure_type", "vault_uuid", "vault_name", "item_id", "error"],
        )
        w.writeheader()
        w.writerows(rows)


# --- arg parsing ------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description=(
            "Export all Login items from 1Password vaults to a timestamped CSV. "
            "See README.md for full documentation."
        )
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Base directory for output. Each run creates a timestamped subfolder. Default: next to script.",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-batch progress. The audit log still captures everything.",
    )
    p.add_argument(
        "--clean",
        action="store_true",
        help="Remove the .op_venv directory and .op_env_meta.json.",
    )
    p.add_argument(
        "--version",
        action="version",
        version=f"items_report.py {SCRIPT_VERSION} (SDK {SDK_VERSION})",
    )
    return p.parse_args()


# --- main run ---------------------------------------------------------------

async def run(args):
    from onepassword.client import Client

    output_dir = (args.output_dir or HERE).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- Authenticate ---------------------------------------------------

    log.write("")
    log.write("-- Authentication ----------------------------------------------")

    desktop_account = os.environ.get(ACCOUNT_KEY, "").strip()

    if desktop_account:
        from onepassword.client import DesktopAuth
        try:
            client = await Client.authenticate(
                auth=DesktopAuth(account_name=desktop_account),
                integration_name="1Password Items Report",
                integration_version=f"v{SCRIPT_VERSION}",
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
                integration_name="1Password Items Report",
                integration_version=f"v{SCRIPT_VERSION}",
            )
        except Exception as e:
            log.write(f"  [x] Authentication failed: {e}")
            return 2
        log.write("  [ok] Authenticated via service account.")

    # --- Vault discovery ------------------------------------------------

    log.write("")
    log.write("-- Vault Discovery ---------------------------------------------")

    explicit_vault_ids = parse_vault_ids() if desktop_account else []

    if explicit_vault_ids:
        # Desktop mode with OP_VAULTS: filter the vault list to only those UUIDs.
        log.write(f"  [>] Looking up {len(explicit_vault_ids)} specified vault(s) ...")
        try:
            all_vaults = list(await client.vaults.list())
        except Exception as e:
            log.write(f"  [x] Could not list vaults: {e}")
            return 2

        vault_by_id = {v.id: v for v in all_vaults}
        vaults = []
        for vid in explicit_vault_ids:
            if vid in vault_by_id:
                vaults.append(vault_by_id[vid])
            else:
                log.write(f"  [!] Vault ID '{vid}' not found in account — skipping.")
        if not vaults:
            log.write("  [x] None of the specified vault IDs were found.")
            available = ", ".join(f"{v.title} ({v.id})" for v in all_vaults[:10])
            log.write(f"      Available: {available}")
            return 2
    else:
        # Service account mode: use whatever vaults the token can access.
        log.write("  [>] Listing vaults accessible to this service account ...")
        try:
            vaults = list(await client.vaults.list())
        except Exception as e:
            log.write(f"  [x] Could not list vaults: {e}")
            return 2
        if not vaults:
            log.write("  [!] No vaults returned. Check account access.")
            return 0

    log.write(f"  [ok] {len(vaults)} vault(s) to scan:")
    for v in vaults:
        log.write(f"       {v.id}  {v.title}")

    # --- Scan vaults for Login items ------------------------------------

    all_rows = []
    max_websites = 0
    max_urls = 0
    total_errors = 0
    failed_items = []

    for vault in vaults:
        vid = vault.id
        vname = vault.title

        log.write("")
        log.write(f"-- Vault: {vname} ({vid}) ----------")
        log.write("  [>] Listing items ...")

        try:
            overviews = list(await client.items.list(vid))
        except Exception as e:
            log.write(f"  [x] Could not list items: {e}")
            total_errors += 1
            failed_items.append({
                "failure_type": "vault_listing",
                "vault_uuid": vid,
                "vault_name": vname,
                "item_id": "(not applicable)",
                "error": str(e),
            })
            continue

        login_overviews = [
            ov for ov in overviews
            if "LOGIN" in str(getattr(ov, "category", "")).upper()
        ]

        total_in_vault = len(overviews)
        login_count = len(login_overviews)
        log.write(
            f"  [ok] {total_in_vault} total, {login_count} Login, "
            f"{total_in_vault - login_count} other (skipped)."
        )

        if login_count == 0:
            continue

        item_ids = [ov.id for ov in login_overviews]
        batch_count = (login_count + BATCH_SIZE - 1) // BATCH_SIZE
        fetched = 0
        errors = 0

        log.write(
            f"  [>] Fetching {login_count} item(s) in {batch_count} "
            f"batch(es) of up to {BATCH_SIZE} ..."
        )

        for batch_num, chunk in enumerate(chunks(item_ids, BATCH_SIZE), start=1):
            progress = f"      Batch {batch_num}/{batch_count} ({len(chunk)} items) ..."
            if not args.quiet:
                print(progress, end=" ", flush=True)
            log.add(progress)

            try:
                response = await client.items.get_all(vid, chunk)
                for res in response.individual_responses:
                    if res.error is not None:
                        errors += 1
                        failed_items.append({
                            "failure_type": "item",
                            "vault_uuid": vid,
                            "vault_name": vname,
                            "item_id": getattr(res, "id", "(unknown)"),
                            "error": str(res.error),
                        })
                        continue
                    item = res.content

                    if not is_login(item):
                        continue

                    sites = website_urls(item)
                    urls = url_fields(item)
                    max_websites = max(max_websites, len(sites))
                    max_urls = max(max_urls, len(urls))

                    all_rows.append({
                        "vault_uuid": vid,
                        "vault_name": vname,
                        "title": item.title or "",
                        "username": field_value(item, "username"),
                        "_websites": sites,
                        "_urls": urls,
                        "tags": item_tags(item),
                        "notes": item_notes(item),
                    })
                    fetched += 1

                done = "done"
                if not args.quiet:
                    print(done)
                log.add(f"        -> {done}")
            except Exception as e:
                em = f"error: {e}"
                if not args.quiet:
                    print(em)
                log.add(f"        -> {em}")
                errors += len(chunk)
                for iid in chunk:
                    failed_items.append({
                        "failure_type": "batch",
                        "vault_uuid": vid,
                        "vault_name": vname,
                        "item_id": iid,
                        "error": str(e),
                    })

        total_errors += errors
        summary = f"  [ok] {fetched}/{login_count} Login item(s) collected"
        if errors:
            summary += f" ({errors} error(s) skipped)"
        log.write(summary)

    # --- Write CSV ------------------------------------------------------

    log.write("")
    log.write("-- Writing CSV -------------------------------------------------")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_dir / f"items_report_{ts}"
    run_dir.mkdir(parents=True, exist_ok=True)

    csv_path = run_dir / "items_report.csv"
    log_path = run_dir / "audit.log"
    err_path = run_dir / "errors.csv"

    if not all_rows:
        log.write("  [!] No Login items found, nothing to write.")
        if failed_items:
            write_errors(err_path, failed_items)
            log.write(f"  [!] Error details saved to: {err_path}")
        log.save(log_path)
        log.write(f"  [ok] Audit log saved to: {log_path}")
        return 1 if total_errors else 0

    website_cols = [f"website_{i + 1}" for i in range(max_websites)]
    url_cols = [f"url_{i + 1}" for i in range(max_urls)]
    fieldnames = (
        ["vault_uuid", "vault_name", "title", "username"]
        + website_cols
        + url_cols
        + ["tags", "notes"]
    )

    log.write(f"  [>] {len(all_rows)} row(s), columns: {', '.join(fieldnames)}")

    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in all_rows:
            sites = row.pop("_websites")
            urls = row.pop("_urls")
            for i, col in enumerate(website_cols):
                row[col] = sites[i] if i < len(sites) else ""
            for i, col in enumerate(url_cols):
                row[col] = urls[i] if i < len(urls) else ""
            writer.writerow(row)

    log.write("")
    log.write("-- Complete ----------------------------------------------------")
    log.write(f"  [ok] {len(all_rows)} row(s) written across {len(vaults)} vault(s).")
    if total_errors:
        log.write(f"  [!] {total_errors} item(s) skipped due to fetch errors.")
    log.write(f"  [ok] Saved to: {csv_path}")

    if failed_items:
        write_errors(err_path, failed_items)
        log.write(f"  [!] Error details saved to: {err_path}")

    log.save(log_path)
    log.write(f"  [ok] Audit log saved to: {log_path}")
    log.write("")

    return 1 if total_errors else 0


# --- entry point ------------------------------------------------------------
#
# Exit codes:
#   0   - complete success, CSV written
#   1   - CSV written but some items failed (see .errors file)
#   2   - fatal error (auth, vault listing)

if __name__ == "__main__":
    args = parse_args()

    if args.clean:
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

    in_venv = bool(os.environ.get(_VENV_FLAG))

    # Only load .env when NOT inside the venv. The parent process already
    # resolved the token and passed it via the environment. Loading .env
    # again would overwrite the resolved plaintext with the raw op:// string.
    if not in_venv:
        load_dotenv()

    has_token = bool(os.environ.get(TOKEN_KEY, "").strip())
    token_plaintext = has_token and not is_op_ref(os.environ.get(TOKEN_KEY, ""))

    if in_venv:
        restore_bootstrap_log()
        try:
            code = asyncio.run(run(args))
            sys.exit(code)
        finally:
            clear_token()
    elif token_plaintext:
        # Service account token already resolved — skip op inject.
        ensure_venv()
        relaunch_in_venv()
    elif has_token:
        # Token is an op:// reference — needs bootstrap to resolve it.
        bootstrap()
    elif is_desktop_mode():
        # No token at all — use desktop auth.
        vault_ids = parse_vault_ids()
        if not vault_ids:
            log.write(
                f"[x] {VAULTS_KEY} is required when using desktop auth.\n"
                f"    Add it to your .env file:\n"
                f"        {ACCOUNT_KEY}=your-account-name\n"
                f"        {VAULTS_KEY}=vault-uuid-1,vault-uuid-2"
            )
            sys.exit(1)
        ensure_venv()
        relaunch_in_venv()
    else:
        bootstrap()