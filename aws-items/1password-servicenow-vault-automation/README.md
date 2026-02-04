# 1Password ServiceNow Vault Automation

Automated 1Password vault provisioning integrated with ServiceNow ticketing. This CloudFormation stack deploys a secure, production-ready API that creates vaults with proper permissions based on ServiceNow requests.

## 🎯 Overview

This solution provides:
- **REST API** for vault creation from ServiceNow workflows
- **Automatic permission management** for users and groups
- **User validation** before vault creation (prevents errors)
- **Request tracking** with DynamoDB and ServiceNow ticket correlation
- **WAF protection** with IP whitelisting and rate limiting
- **CloudWatch monitoring** with optional SNS alerts
- **Full audit trail** with structured logging

## 📋 Prerequisites

### Required

1. **AWS Account** with permissions to create:
   - CloudFormation stacks
   - Lambda functions
   - API Gateway
   - DynamoDB tables
   - IAM roles
   - Secrets Manager secrets
   - WAF resources

2. **1Password Business Account** with:
   - Service account with vault creation permissions
   - Service account token (from 1Password.com)
   - User UUIDs for the requesting users (must exist in 1Password)

3. **Group/User UUIDs** (hardcoded in template):
   - Update `FIXED_PERMISSIONS` in the Lambda code with your actual group/user UUIDs
   - Get UUIDs with: `op group list --format json` and `op user list --format json`

### Optional

- **Email address** for CloudWatch alerts (recommended for production)
- **API key** for ServiceNow authentication (recommended)
- **IP allowlist** for enhanced security (recommended for production)

## 🚀 Quick Start

### 1. Update Group/User UUIDs

**IMPORTANT:** Before deploying, update the `FIXED_PERMISSIONS` array in the Lambda code (lines ~30-50) with your actual 1Password group/user UUIDs:

```python
FIXED_PERMISSIONS = [
    {
        'identifier': 'YOUR_OWNERS_GROUP_UUID',
        'type': 'group',
        'name': 'Owners',
        'permissions': 'manage_vault'
    },
    # ... add your groups/users here
]
```

Get your UUIDs:
```bash
# List all groups with UUIDs
op group list --format json

# List all users with UUIDs
op user list --format json
```

### 2. Deploy the Stack

1. Go to **AWS Console** → **CloudFormation** → **Create Stack**
2. Upload `1password-servicenow-vault-automation.yaml`
3. Fill in required parameters:
   - **OPServiceAccountToken**: Your 1Password service account token
   - **AlertEmail**: Email for alerts (optional but recommended)
   - **ApiKeyValue**: API key for ServiceNow (optional but recommended)
   - **AllowedIPRanges**: Comma-separated CIDRs (e.g., `203.0.113.0/24,198.51.100.0/24`)
4. Check "I acknowledge that AWS CloudFormation might create IAM resources"
5. Click **Create Stack**

### 3. Get API Information

After stack creation completes:

**Get API Endpoint:**
1. Go to CloudFormation → Your Stack → **Outputs** tab
2. Copy the `CreateVaultEndpoint` value

**Get API Key (if using authentication):**
1. Go to **API Gateway** → **API Keys**
2. Find key named `<StackName>-ServiceNowApiKey`
3. Click **Show** to reveal the API key value

## 📡 API Usage

### Create Vault

**Endpoint:** `POST /vault`

**Headers:**
```http
Content-Type: application/json
X-Api-Key: your-api-key  # If API key authentication enabled
```

**Request Body:**
```json
{
  "vaultName": "Engineering-SecretsDev",
  "userEmail": "john.doe@example.com",
  "description": "Development secrets for Engineering team",
  "serviceNowTicket": "INC0012345",
  "requester": "ServiceNow"
}
```

**Required Fields:**
- `vaultName` - Exact vault name (1-64 chars, letters/numbers/spaces/hyphens/underscores)
- `userEmail` - User email (must exist in 1Password)

**Optional Fields:**
- `description` - Vault description
- `serviceNowTicket` - ServiceNow ticket number (for tracking)
- `requester` - Who initiated the request (default: "ServiceNow")

**Success Response (200):**
```json
{
  "success": true,
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "serviceNowTicket": "INC0012345",
  "vaultName": "Engineering-SecretsDev",
  "message": "Vault 'Engineering-SecretsDev' created successfully. All 5 permissions granted.",
  "details": {
    "vaultCreated": true,
    "permissionsGranted": 5,
    "permissionsExpected": 5
  },
  "permissions_granted": [
    {
      "type": "user",
      "identifier": "john.doe@example.com",
      "uuid": "abc123...",
      "permissions": "ALL (including manage_vault)",
      "status": "success"
    },
    {
      "type": "group",
      "name": "Owners",
      "identifier": "oiha25n4...",
      "permissions": "manage_vault",
      "status": "success"
    }
    // ... more permissions
  ],
  "warnings": []
}
```

**Error Response (400) - User doesn't exist:**
```json
{
  "success": false,
  "error": "User email 'john.doe@example.com' does not exist in 1Password",
  "message": "Vault NOT created. User email must exist in 1Password.",
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userEmail": "john.doe@example.com"
}
```

**Error Response (400) - Validation error:**
```json
{
  "success": false,
  "errors": ["Missing required field: vaultName"],
  "message": "Request validation failed"
}
```

### Check Request Status

**Endpoint:** `GET /status`

**Query Parameters:**
- `requestId` - Request ID from creation response
- `serviceNowTicket` - ServiceNow ticket number

**Example:**
```bash
GET /status?requestId=a1b2c3d4-e5f6-7890-abcd-ef1234567890
GET /status?serviceNowTicket=INC0012345
```

**Response:**
```json
{
  "success": true,
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "serviceNowTicket": "INC0012345",
  "vaultName": "Engineering-SecretsDev",
  "userEmail": "john.doe@example.com",
  "status": "completed",
  "requester": "ServiceNow",
  "createdAt": "2026-02-04T15:30:00.000Z",
  "completedAt": "2026-02-04T15:30:15.000Z",
  "result": { /* full creation result */ }
}
```

**Status Values:**
- `processing` - Vault creation in progress
- `completed` - Successfully created
- `partial` - Created but some permissions failed
- `failed` - Creation failed

## 🧪 Testing

### Test Vault Creation

Use any HTTP client (Postman, curl, etc.):

**Request:**
```http
POST https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vault
Content-Type: application/json
X-Api-Key: your-api-key

{
  "vaultName": "Test-Vault-123",
  "userEmail": "test.user@example.com",
  "description": "Test vault",
  "serviceNowTicket": "TEST001"
}
```

**Using curl:**
```bash
curl -X POST "https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vault" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{
    "vaultName": "Test-Vault-123",
    "userEmail": "test.user@example.com",
    "description": "Test vault",
    "serviceNowTicket": "TEST001"
  }'
```

### Test Status Endpoint

```bash
curl "https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/status?requestId=YOUR_REQUEST_ID" \
  -H "X-Api-Key: your-api-key"
```

## 🔒 Security Features

### IP Whitelisting (WAF)

The stack includes AWS WAF with IP-based access control:
- Set `AllowedIPRanges` parameter to restrict access
- Default: `0.0.0.0/0` (allows all IPs - change for production!)
- Example: `203.0.113.0/24,198.51.100.0/24`

### Rate Limiting

- **100 requests per 5 minutes** per IP address
- Returns HTTP 429 if exceeded
- Configurable in WAF rules

### API Key Authentication

Optional but recommended:
- Set `ApiKeyValue` parameter during deployment
- Include `X-Api-Key` header in all requests
- Retrieve actual key value with AWS CLI (see above)

### AWS Managed WAF Rules

Automatic protection against:
- OWASP Top 10 vulnerabilities
- Known bad inputs
- SQL injection
- Cross-site scripting (XSS)

### User Validation

- Validates user email exists in 1Password **before** creating vault
- Prevents orphaned vaults with no owner
- Returns clear error if user doesn't exist

## 📊 Monitoring & Logging

### CloudWatch Logs

**Lambda Logs:**
- `/aws/lambda/<StackName>-CreateVault` - Vault creation logs (30 day retention)
- `/aws/lambda/<StackName>-GetStatus` - Status check logs (30 day retention)

**WAF Logs:**
- `aws-waf-logs-<StackName>` - Blocked requests (7 day retention)

**Structured JSON Logging:**
```json
{
  "timestamp": "2026-02-04T15:30:00.000Z",
  "level": "INFO",
  "message": "Vault created successfully",
  "vaultName": "Engineering-SecretsDev",
  "requestId": "a1b2c3d4-..."
}
```

### CloudWatch Alarms

If `AlertEmail` parameter is set, you'll receive SNS alerts for:

1. **Lambda Errors** - 5+ errors in 5 minutes
2. **Lambda Throttles** - 3+ throttles in 5 minutes
3. **WAF Blocks** - 10+ blocked requests in 5 minutes
4. **Rate Limiting** - 5+ rate limit triggers in 5 minutes

### DynamoDB Tracking

All requests stored in `<StackName>-Requests` table:
- **Primary Key:** RequestId
- **GSI:** ServiceNowTicket + CreatedAt
- **TTL:** 90 days (auto-deletion)
- **Point-in-Time Recovery:** Enabled

View requests:
1. Go to **DynamoDB** → **Tables** → `<StackName>-Requests`
2. Click **Explore table items**
3. Use **Query** with ServiceNowTicketIndex to find requests by ticket number

## 🔧 Configuration

### Parameters Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| **OPServiceAccountToken** | String | *Required* | 1Password service account token |
| **OPCliVersion** | String | `2.32.0` | 1Password CLI version to download |
| **SecretName** | String | `OPServiceToken` | Name for Secrets Manager secret |
| **LambdaMemory** | Number | `512` | Lambda memory in MB (256-10240) |
| **LambdaTimeout** | Number | `300` | Lambda timeout in seconds (30-900) |
| **StageName** | String | `prod` | API Gateway stage (dev/staging/prod) |
| **ApiKeyValue** | String | *(empty)* | API key for authentication (optional) |
| **AlertEmail** | String | *(empty)* | Email for CloudWatch alerts (optional) |
| **AllowedIPRanges** | List | `0.0.0.0/0` | Comma-separated IP CIDRs (optional) |

### Environment-Specific Configs

**Development:**
```json
{
  "StageName": "dev",
  "AllowedIPRanges": "0.0.0.0/0",
  "ApiKeyValue": "",
  "AlertEmail": ""
}
```

**Production:**
```json
{
  "StageName": "prod",
  "AllowedIPRanges": "203.0.113.0/24,198.51.100.0/24",
  "ApiKeyValue": "strong-random-key-here",
  "AlertEmail": "ops-team@example.com"
}
```

## 🛠️ Troubleshooting

### Vault Creation Fails

**Check Lambda Logs:**
1. Go to **CloudWatch** → **Log groups**
2. Find `/aws/lambda/<StackName>-CreateVault`
3. Click **Search log group** and look for errors

**Common Issues:**

1. **"User email does not exist"**
   - Verify user exists in 1Password
   - User must be active (not suspended)
   - Check spelling of email address

2. **"Vault already exists"**
   - Returns success with `vaultExisted: true`
   - No permissions are modified

3. **Permission grant fails**
   - Check group/user UUIDs in `FIXED_PERMISSIONS`
   - Verify service account has permission to grant access
   - Check CloudWatch logs for specific error

### API Returns 403 Forbidden

**WAF is blocking your IP:**
1. Go to **CloudWatch** → **Log groups** → `aws-waf-logs-<StackName>`
2. Check for blocked requests
3. Update `AllowedIPRanges` parameter in CloudFormation
4. Update the stack

**Check allowed IPs:**
1. Go to **WAF & Shield** → **IP sets**
2. Find `<StackName>-AllowedIPs`
3. Verify your IP is in the list

### API Returns 429 Too Many Requests

- Rate limit exceeded (100 requests per 5 minutes per IP)
- Wait 5 minutes or adjust WAF rules

### CloudWatch Alarms Not Working

1. Check email for SNS subscription confirmation
2. Verify `AlertEmail` parameter was set during deployment
3. Check **SNS** → **Subscriptions** to see if confirmed

## 🔄 Updates & Maintenance

### Update the Stack

1. Go to **CloudFormation** → Your Stack
2. Click **Update**
3. Choose **Replace current template**
4. Upload updated `1password-servicenow-vault-automation.yaml`
5. Update parameters if needed
6. Click through to update

### Update Group/User Permissions

1. Edit `FIXED_PERMISSIONS` array in the template
2. Update the stack (see above)
3. Lambda function will automatically update with new permissions

### Rotate Service Account Token

1. Go to **Secrets Manager**
2. Find secret `<StackName>-OPServiceToken`
3. Click **Retrieve secret value** → **Edit**
4. Enter new service account token
5. Save

No Lambda restart needed - token is fetched fresh on each invocation.

### Update 1Password CLI Version

1. Update `OPCliVersion` parameter in CloudFormation
2. Update the stack
3. Lambda will download new version on next cold start

## 🗑️ Cleanup

### Delete the Stack

1. Go to **CloudFormation** → Your Stack
2. Click **Delete**
3. Confirm deletion

**⚠️ Note:** 
- Deleting the stack does NOT delete vaults created by it
- DynamoDB table will be deleted (90-day TTL would have cleaned it anyway)
- Manually remove test vaults from 1Password if needed

## 📝 Architecture

```
ServiceNow ──HTTP POST──> API Gateway ──invoke──> CreateVault Lambda
                             │                        │
                             │                        ├─ Download 1Password CLI
                             │                        ├─ Validate user exists
                             │                        ├─ Create vault
                             │                        ├─ Grant permissions
                             │                        └─ Update DynamoDB
                             │
                             WAF ─── IP Check
                                 └── Rate Limit
                                 └── OWASP Rules

DynamoDB ─────TTL (90d)────> Auto-delete old records
    │
    └─── GSI: ServiceNowTicket ──query──> GET /status
```

## 🤝 Contributing

1. Update group/user UUIDs before deploying
2. Test in dev environment first
3. Use proper IAM permissions (least privilege)
4. Enable CloudWatch alarms in production
5. Use API key authentication
6. Whitelist ServiceNow IPs only

## 🆘 Support

- **CloudWatch Logs:** Check Lambda and WAF logs first
- **DynamoDB:** Query requests table for historical data
- **AWS Support:** Open case if AWS service issues
- **1Password Support:** Contact for service account or CLI issues

---

**Last Updated:** 2026-02-04  
**CloudFormation Version:** 1.0  
**Tested With:** 1Password CLI 2.32.0, AWS Lambda Python 3.12