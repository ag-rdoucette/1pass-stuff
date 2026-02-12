# 1Password ServiceNow Vault Automation

Automated 1Password vault provisioning integrated with ServiceNow ticketing. This CloudFormation stack deploys a REST API that creates vaults and grants permissions to users and groups based on ServiceNow requests.

## Overview

- **REST API** for vault creation from ServiceNow workflows
- **Dynamic permission management** — pass users, groups, and their permissions per request (nothing hardcoded)
- **Automatic permission dependency resolution** — request `delete_items` and the system adds `view_items`, `edit_items`, and `view_and_copy_passwords` automatically
- **Shorthand permission bundles** — use `allow_viewing`, `allow_editing`, or `allow_managing` for quick assignment
- **User validation** before vault creation (prevents orphaned vaults)
- **Group grants via SDK**, user grants via CLI, vault creation via CLI
- **Request tracking** with DynamoDB and ServiceNow ticket correlation
- **WAF protection** with IP whitelisting and rate limiting (optional)
- **CloudWatch monitoring** with optional SNS alerts

## Prerequisites

### Required

1. **AWS Account** with permissions to create CloudFormation stacks, Lambda functions, API Gateway, DynamoDB tables, IAM roles, Secrets Manager secrets, and WAF resources.

2. **1Password Business Account** with a service account that has vault creation permissions and a provisioned service account token.

3. **1Password SDK Lambda Layer** (optional but recommended) — the Python SDK beta (`onepassword-sdk==0.4.0b2`) is used for granting group permissions. If the layer is not present, group grants fall back to CLI automatically. Build the layer:
   ```bash
   mkdir -p layer/python
   pip install onepassword-sdk==0.4.0b2 -t layer/python \
       --platform manylinux2014_x86_64 --only-binary=:all:
   cd layer && zip -r ../op-sdk-layer.zip python
   ```
   Upload to S3 and add as a Layer to the `CreateVaultLambda`.

### Optional

- Email address for CloudWatch alerts
- API key for ServiceNow authentication
- IP allowlist for WAF (recommended for production)

## Quick Start

### 1. Deploy the Stack

1. Go to **AWS Console** → **CloudFormation** → **Create Stack**
2. Upload `cloudformation-template.yaml`
3. Fill in parameters:
   - **OPServiceAccountToken** — your 1Password service account token
   - **AlertEmail** — email for alerts (optional)
   - **ApiKeyValue** — API key for ServiceNow auth (optional)
   - **AllowedIPRanges** — comma-separated CIDRs to enable WAF (e.g. `203.0.113.0/24,198.51.100.0/24`). Leave as `0.0.0.0/0` to skip WAF entirely.
4. Acknowledge IAM resource creation and click **Create Stack**

### 2. Get API Information

After the stack creates successfully:

- **API Endpoint** — CloudFormation → Outputs → `CreateVaultEndpoint`
- **API Key** (if enabled) — API Gateway → API Keys → `<StackName>-ServiceNowApiKey` → Show

## API Usage

### Create Vault

`POST /vault`

**Headers:**
```
Content-Type: application/json
X-Api-Key: your-api-key
```

**Request Body:**
```json
{
  "vaultName": "Engineering-Secrets",
  "description": "Shared vault for engineering team",
  "serviceNowTicket": "INC0012345",
  "requester": "ServiceNow",
  "permissions": [
    {
      "type": "user",
      "email": "alice@company.com",
      "permissions": ["allow_editing", "manage_vault"]
    },
    {
      "type": "group",
      "groupId": "oiha25n4kwtwjtuflebbwk43iq",
      "permissions": ["manage_vault"]
    },
    {
      "type": "group",
      "groupId": "7urbsw7hvbgpdovz4hbwld7wce",
      "permissions": ["view_items", "create_items", "edit_items"]
    },
    {
      "type": "user",
      "email": "bob@company.com",
      "permissions": ["allow_viewing"]
    }
  ]
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `vaultName` | Yes | 1–64 characters: letters, numbers, spaces, hyphens, underscores |
| `permissions` | No | Array of user/group permission grants (see below) |
| `description` | No | Vault description |
| `serviceNowTicket` | No | ServiceNow ticket number for tracking |
| `requester` | No | Who initiated the request (default: `ServiceNow`) |

**Permission Grant Object:**

For users:
```json
{ "type": "user", "email": "user@company.com", "permissions": ["allow_editing"] }
```

For groups:
```json
{ "type": "group", "groupId": "group-uuid-here", "permissions": ["view_items", "create_items"] }
```

### Permission Reference

You can pass individual permissions, shorthand bundles, or mix both. Dependencies are resolved automatically.

**Individual Permissions:**

| Permission | Auto-adds |
|------------|-----------|
| `view_items` | *(none)* |
| `create_items` | `view_items` |
| `edit_items` | `view_items`, `view_and_copy_passwords` |
| `archive_items` | `view_items`, `edit_items`, `view_and_copy_passwords` |
| `delete_items` | `view_items`, `edit_items`, `view_and_copy_passwords` |
| `view_and_copy_passwords` | `view_items` |
| `view_item_history` | `view_items`, `view_and_copy_passwords` |
| `import_items` | `view_items`, `create_items` |
| `export_items` | `view_items`, `view_and_copy_passwords`, `view_item_history` |
| `copy_and_share_items` | `view_items`, `view_and_copy_passwords`, `view_item_history` |
| `move_items` | `view_items`, `edit_items`, `delete_items`, `view_and_copy_passwords`, `view_item_history`, `copy_and_share_items` |
| `print_items` | `view_items`, `view_and_copy_passwords`, `view_item_history` |
| `manage_vault` | *(none)* |

**Shorthand Bundles:**

| Bundle | Includes |
|--------|----------|
| `allow_viewing` | `view_items`, `view_and_copy_passwords`, `view_item_history` |
| `allow_editing` | Everything in `allow_viewing` + `create_items`, `edit_items`, `archive_items`, `delete_items`, `import_items`, `export_items`, `copy_and_share_items`, `print_items` |
| `allow_managing` | `manage_vault` |

Bundles can be combined: `["allow_editing", "manage_vault"]` gives full access.

### Success Response (200)

```json
{
  "success": true,
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "serviceNowTicket": "INC0012345",
  "vaultName": "Engineering-Secrets",
  "message": "Vault 'Engineering-Secrets' created successfully. All 4 permissions granted.",
  "details": {
    "vaultCreated": true,
    "permissionsGranted": 4,
    "permissionsExpected": 4
  },
  "permissions_granted": [
    {
      "type": "user",
      "email": "alice@company.com",
      "uuid": "abc123...",
      "requested_permissions": ["allow_editing", "manage_vault"],
      "resolved_permissions": ["archive_items", "copy_and_share_items", "create_items", "delete_items", "edit_items", "export_items", "import_items", "manage_vault", "print_items", "view_and_copy_passwords", "view_item_history", "view_items"],
      "method": "cli",
      "status": "success"
    },
    {
      "type": "group",
      "groupId": "oiha25n4kwtwjtuflebbwk43iq",
      "requested_permissions": ["manage_vault"],
      "resolved_permissions": ["manage_vault"],
      "method": "sdk",
      "status": "success"
    }
  ],
  "warnings": []
}
```

### Error Responses

**User doesn't exist (400):**
```json
{
  "success": false,
  "errors": ["User 'nobody@company.com' not found in 1Password"],
  "message": "Vault NOT created. All user emails must exist in 1Password.",
  "requestId": "a1b2c3d4-..."
}
```

**Validation error (400):**
```json
{
  "success": false,
  "errors": ["permissions[0]: user type requires 'email'"],
  "message": "Request validation failed"
}
```

### Check Request Status

`GET /status?requestId=a1b2c3d4-...` or `GET /status?serviceNowTicket=INC0012345`

**Response:**
```json
{
  "success": true,
  "requestId": "a1b2c3d4-...",
  "serviceNowTicket": "INC0012345",
  "vaultName": "Engineering-Secrets",
  "status": "completed",
  "requester": "ServiceNow",
  "createdAt": "2026-02-07T15:30:00.000Z",
  "completedAt": "2026-02-07T15:30:15.000Z",
  "permissionGrants": 4,
  "result": { }
}
```

Status values: `processing`, `completed`, `partial` (some grants failed), `failed`.

## How It Works

```
ServiceNow ── POST /vault ──> API Gateway ──> CreateVault Lambda
                                  │                  │
                                  │                  ├─ Validate request & all user emails
                                  │                  ├─ Download 1Password CLI
                                  │                  ├─ Create vault (CLI)
                                  │                  ├─ Get vault UUID (CLI)
                                  │                  ├─ Grant group permissions (SDK, CLI fallback)
                                  │                  ├─ Grant user permissions (CLI)
                                  │                  └─ Update DynamoDB
                                  │
                                  WAF (if enabled)
                                    ├─ IP whitelist
                                    ├─ Rate limit (100/5min per IP)
                                    └─ AWS managed rules
```

**Why the split between SDK and CLI?**

The 1Password Python SDK can grant group permissions to any vault via `grant_group_permissions`. However, the SDK cannot grant vault access to individual users — this requires the CLI. Vault creation also requires the CLI. If the SDK Lambda Layer is not installed, group grants automatically fall back to CLI, so the system works either way.

## Security

### WAF (Optional)

WAF is only created when `AllowedIPRanges` is set to something other than `0.0.0.0/0`. When enabled it provides IP whitelisting, rate limiting (100 requests per 5 minutes per IP, HTTP 429 on exceed), and AWS managed rules (OWASP Top 10, known bad inputs).

### API Key Authentication

Set `ApiKeyValue` during deployment. Include `X-Api-Key` header in all requests.

### User Validation

All user emails in the `permissions` array are validated against 1Password before the vault is created. If any user doesn't exist, the entire request fails fast — no vault is created.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `OPServiceAccountToken` | String | *Required* | 1Password service account token |
| `OPCliVersion` | String | `2.32.0` | 1Password CLI version |
| `SecretName` | String | `OPServiceToken` | Secrets Manager secret name |
| `LambdaMemory` | Number | `512` | Lambda memory in MB (256–10240) |
| `LambdaTimeout` | Number | `300` | Lambda timeout in seconds (30–900) |
| `StageName` | String | `prod` | API Gateway stage (`dev`, `staging`, `prod`) |
| `ApiKeyValue` | String | *(empty)* | API key for authentication |
| `AllowedIPRanges` | List | `0.0.0.0/0` | Comma-separated CIDRs for WAF. Default disables WAF. |
| `AlertEmail` | String | *(empty)* | Email for CloudWatch alerts |

## Monitoring

### CloudWatch Logs

- `/aws/lambda/<StackName>-CreateVault` — vault creation (30-day retention)
- `/aws/lambda/<StackName>-GetStatus` — status checks (30-day retention)
- `aws-waf-logs-<StackName>` — WAF activity (7-day retention, only if WAF enabled)

All Lambda logs are structured JSON with timestamp, level, message, and context fields.

### Alarms (if `AlertEmail` is set)

- **Lambda Errors** — 5+ errors in 5 minutes
- **Lambda Throttles** — 3+ throttles in 5 minutes
- **WAF Blocks** — 10+ blocked requests in 5 minutes (only if WAF enabled)
- **WAF Rate Limit** — 5+ rate limit triggers in 5 minutes (only if WAF enabled)

### DynamoDB

All requests are stored in `<StackName>-Requests` with a 90-day TTL, point-in-time recovery, and a GSI on `ServiceNowTicket` for lookup by ticket number.

## Troubleshooting

### Vault Creation Fails

Check `/aws/lambda/<StackName>-CreateVault` in CloudWatch Logs. Common causes: user email doesn't exist in 1Password, service account lacks vault creation permission, vault name already exists (returns success with `vaultExisted: true`).

### Permission Grant Fails

The response includes per-grant detail with `status`, `method`, and `error`. For group grants, the system tries SDK first and falls back to CLI — check whether the SDK layer is installed. For user grants, verify the user UUID was resolved (check `uuid` in the response).

### API Returns 403

If WAF is enabled, your IP may not be in the allowlist. Check `aws-waf-logs-<StackName>` in CloudWatch, then update `AllowedIPRanges` in the CloudFormation stack.

### API Returns 429

Rate limit exceeded (100 requests per 5 minutes per IP). Wait and retry.

## Maintenance

### Rotate Service Account Token

Update the secret value in Secrets Manager at `<StackName>-OPServiceToken`. No Lambda restart needed — the token is fetched fresh on each invocation.

### Update 1Password CLI Version

Update the `OPCliVersion` parameter and update the stack. The Lambda downloads the new version on its next cold start.

### Delete the Stack

CloudFormation → Delete Stack. This does **not** delete vaults already created in 1Password. The DynamoDB table and all AWS resources are removed.

---