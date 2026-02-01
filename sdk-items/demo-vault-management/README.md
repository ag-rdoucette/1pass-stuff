# 1Password Vault Manager

A local web app for managing 1Password vault permissions across groups. Built with the 1Password Desktop Auth SDK and the `op` CLI.

## How It Works

Authentication runs as a three-step flow when you sign in:

1. **CLI signin** — `op signin` authenticates your session against the selected account via the desktop app.
2. **Group fetch** — `op group list` pulls all groups for that account. The Recovery group is automatically excluded.
3. **SDK auth** — The `@1password/sdk` Desktop Auth initializes and prompts for integration permission in the 1Password desktop app.

After that, the CLI is no longer used. All vault and permission operations run through the SDK for the rest of the session. Groups are held in memory — no hardcoded IDs, no config file needed.

## Prerequisites

- **1Password desktop app** — must be running and signed in, with **1Password Developer** enabled (Settings > Developer > Show 1Password Developer experience)
- **`op` CLI** — installed and integrated with the desktop app
- **Node.js** — 18 or higher

## Setup

Clone the repo and install dependencies:

```bash
git clone <repo-url>
cd 1pass-stuff/sdk-items
npm install
```

The app loads its configuration from a `.env` file using [1Password Environments](https://developer.1password.com/docs/environments/). No manual `.env` file is needed — 1Password mounts it for you. To set this up:

1. In the 1Password desktop app, go to **Developer** > **View Environments**
2. Create a new environment (or open an existing one) for this project
3. Add your variables — at minimum `OP_ACCOUNT_NAMES` with your account domain(s), comma-separated if you have more than one. Optionally set `PORT` if you want something other than 3000
4. Under **Destinations**, configure a **Local .env file** and point it to the `.env` path in this project directory
5. Authorize when prompted

After that, 1Password handles the rest. The `.env` file never exists as plaintext on disk — it's provided securely by the desktop app when the server reads it.

### Variables

| Variable | Required | Description |
|---|---|---|
| `OP_ACCOUNT_NAMES` | Yes | Comma-separated list of 1Password account domains |
| `PORT` | No | Server port. Defaults to `3000` |

## Running

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For development with auto-reload:

```bash
npm run dev
```

## Using the App

1. Select an account from the dropdown
2. Click **Authenticate** — the app will sign in via CLI, fetch your groups, then prompt for SDK permission in the 1Password desktop app
3. Once authenticated, you'll see all your vaults on the Vaults tab and all groups (minus Recovery) on the Groups tab
4. Select one or more vaults, click **Grant Permissions**, choose which permissions and which groups to apply them to, and submit

## Permissions

The app supports all 12 vault-level permissions. Some have dependencies — selecting a higher-level permission will automatically check its required permissions, and unchecking one will uncheck anything that depends on it.

| Permission | Depends On |
|---|---|
| View Items | — |
| Create Items | View Items |
| View Passwords | View Items |
| Edit Items | View Items, View Passwords |
| Archive Items | View Items, Edit Items, View Passwords |
| Delete Items | View Items, Edit Items, View Passwords |
| View History | View Items, View Passwords |
| Import Items | View Items, Create Items |
| Export Items | View Items, View Passwords, View History |
| Share Items | View Items, View Passwords, View History |
| Print Items | View Items, View Passwords, View History |
| Manage Vault | — |

## Project Structure

```
sdk-items/demo-vault-management/
├── server.js           # Express server, auth flow, API endpoints
├── package.json
├── .env                # Mounted by 1Password Environments (gitignored)
└── public/
    ├── index.html      # UI layout and styles
    ├── app.js          # Frontend logic
    └── 1password-logo.svg
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/accounts` | Returns configured accounts from `.env` |
| GET | `/api/auth?account=` | SSE stream — runs the 3-step auth flow |
| GET | `/api/vaults` | Lists all vaults via SDK |
| GET | `/api/vaults/:id/permissions` | Gets group and user permissions for a vault |
| POST | `/api/vaults/bulk-grant-permissions` | Grants permissions on multiple vaults to multiple groups |
| POST | `/api/vaults/:id/revoke-permissions` | Revokes a group's permissions on a vault |
| DELETE | `/api/vaults/:id` | Deletes a vault |
| GET | `/api/groups` | Returns groups fetched during auth |
| GET | `/api/groups/:id/vaults` | Returns vaults a group has access to |