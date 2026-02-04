# 1Password Event Monitoring & Alerting System

A fully serverless AWS solution that monitors 1Password events in real-time, automatically creates Secure Notes for critical security events, and sends email alerts to designated recipients.

## 🎯 Overview

This system continuously polls the 1Password Events API, processes security-relevant events (sign-ins, audit events, item usage), and takes automated actions when configured rules match. When a monitored user signs in or specific event types occur, the system:

1. **Creates a Secure Note** in 1Password with full event details
2. **Sends an email alert** to designated recipients
3. **Archives event data** to S3 for compliance and auditing

### Key Features

- **🔍 Real-Time Monitoring** - Polls 1Password Events API at configurable intervals (1-60 minutes)
- **📝 Automatic Documentation** - Creates timestamped Secure Notes with detailed event information
- **📧 Email Alerts** - Sends formatted HTML emails via Amazon SES
- **🗂️ Event Archival** - Stores all events in encrypted S3 with lifecycle management
- **🎯 Flexible Rules** - Monitor specific users, event types, or combinations
- **🔐 Zero-Installation Dependencies** - Python SDK installed at runtime, no layers required
- **🌍 Multi-Region Support** - Works with 1Password accounts in US, Canada, and EU
- **📊 Complete Audit Trail** - CloudWatch logs + S3 archives for compliance

## 🏗️ Architecture

```
EventBridge (Scheduler)
    ↓
Poller Lambda → 1Password Events API
    ↓
  [Fetch new events using cursors for each event type]
    ↓
Write to S3 (encrypted)
    ↓
Invoke Processor Lambda
    ↓
  [Load alert_rules.json from S3]
  [Match events against rules]
    ↓
For each match:
    ├─→ Create Secure Note (1Password SDK)
    └─→ Send Email Alert (SES)
```

### Component Breakdown

- **EventBridge Rule**: Triggers the Poller on a schedule
- **Poller Lambda**: Fetches events from 1Password Events API, writes to S3
- **Processor Lambda**: Matches events against rules, creates notes, sends emails
- **S3 Bucket**: Stores event archives and alert rules
- **Secrets Manager**: Securely stores API tokens
- **SSM Parameter Store**: Tracks API cursors for incremental polling
- **SES**: Sends email notifications

## 📋 Prerequisites

Before deploying, you need:

1. **AWS Account** with permissions to create Lambda, S3, IAM, etc.
2. **1Password Business or Teams Account**
3. **1Password Events API Token** ([How to get one](#getting-1password-api-tokens))
4. **1Password Service Account Token** ([How to get one](#getting-1password-api-tokens))
5. **1Password Vault ID** where Secure Notes will be created
6. **AWS SES Verified Email** for sending alerts

### Getting 1Password API Tokens

#### Events API Token (Bearer Token)
1. Sign in to your 1Password account at https://my.1password.com
2. Go to **Settings** → **Events**
3. Click **Generate token**
4. Copy the token (it will only be shown once)
5. Save it securely for the CloudFormation deployment

#### Service Account Token (SDK Token)
1. In 1Password, go to **Settings** → **Service Accounts**
2. Create a new service account or select an existing one
3. Click **Manage tokens**
4. Click **Issue token**
5. Copy the token (starts with `ops_`)
6. Save it securely for the CloudFormation deployment

#### Vault ID
1. In 1Password, go to **Settings** → **Vaults**
2. Click on the vault where you want Secure Notes created
3. Click **Copy Vault ID**
4. This is a 26-character lowercase alphanumeric string

### SES Configuration

⚠️ **IMPORTANT**: Your sender email MUST be verified in AWS SES before deployment.

**To verify your email in the AWS Console:**
1. Go to [Amazon SES Console](https://console.aws.amazon.com/ses/)
2. Click "Verified identities" in the left menu
3. Click "Create identity"
4. Select "Email address"
5. Enter your sender email
6. Click "Create identity"
7. Check your email and click the verification link

If your AWS account is in the SES sandbox, you must also verify recipient emails or request production access.

## 🚀 Quick Start

### Step 1: Deploy the CloudFormation Stack

**Using AWS Console:**
1. Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
2. Click "Create stack" → "With new resources (standard)"
3. Upload the `1password-event-monitoring.yaml` template file
4. Click "Next"
5. Enter a stack name (e.g., `1password-monitoring`)
6. Fill in the required parameters:
   - **OnePasswordVaultId**: The 26-character vault ID (e.g., `abcdefghijklmnopqrstuvwxyz`)
   - **SesVerifiedSenderEmail**: Your SES-verified sender email
   - **AlertNotifyEmail**: Email that receives alerts
   - **MonitoredUserEmail**: 1Password user to monitor for sign-ins
   - **OnePasswordEventsApiToken**: Your Events API bearer token
   - **OnePasswordSdkServiceAccountToken**: Your service account token
7. Configure optional parameters:
   - **PollIntervalMinutes**: How often to check for events (default: 5)
   - **OnePasswordRegionDomain**: Your account region (default: 1password.com)
   - **OnePasswordEventTypes**: Event types to monitor (default: all)
   - **Environment**: Deployment environment (default: prod)
8. Click "Next" through the remaining screens
9. Check "I acknowledge that AWS CloudFormation might create IAM resources with custom names"
10. Click "Submit"

**Wait for stack creation to complete** (3-5 minutes). The stack status will change to `CREATE_COMPLETE`.

### Step 2: Verify Deployment

1. In the CloudFormation Console, select your stack
2. Click the "Outputs" tab to see:
   - S3 bucket name
   - Lambda function names
   - Secrets Manager secret names

### Step 3: Test the System

**Manual Test:**
1. Go to [Lambda Console](https://console.aws.amazon.com/lambda/)
2. Find the Poller function (e.g., `1password-event-poller-prod`)
3. Click "Test" tab
4. Create a test event (any name, default JSON is fine)
5. Click "Test"
6. Check the execution result for success
7. View CloudWatch Logs to see if events were fetched

**Real Test:**
1. Sign in to 1Password with the monitored user account
2. Wait for the next scheduled poll (up to `PollIntervalMinutes`)
3. Check your email for an alert
4. Check 1Password vault for a new Secure Note

## ⚙️ Configuration

### Monitoring Multiple Users

To monitor multiple users for sign-in events, you need to update the alert rules:

1. Go to [S3 Console](https://console.aws.amazon.com/s3/)
2. Find your events bucket (name in CloudFormation Outputs)
3. Navigate to `rules/alert_rules.json`
4. Download the file
5. Edit the `signin_alerts` array:

```json
{
  "signin_alerts": [
    {
      "email": "user1@example.com",
      "note_title": "Security Alert: user1@example.com Sign-In Detected",
      "tags": ["security", "signin-alert", "user1"],
      "notify_email": "security-team@example.com"
    },
    {
      "email": "user2@example.com",
      "note_title": "Security Alert: user2@example.com Sign-In Detected",
      "tags": ["security", "signin-alert", "user2"],
      "notify_email": "security-team@example.com"
    }
  ],
  "event_type_alerts": []
}
```

6. Upload the modified file back to S3 at `rules/alert_rules.json`

**OR** update via CloudFormation:
1. Edit the template's `RulesUploadTrigger` resource
2. Modify the `Rules` parameter in the `Sub` function
3. Update the stack

### Monitoring Specific Event Types

To alert on specific event types (not just sign-ins), add to the `event_type_alerts` array:

```json
{
  "signin_alerts": [...],
  "event_type_alerts": [
    {
      "event_type": "vault.create",
      "note_title": "Alert: New Vault Created",
      "tags": ["security", "vault-creation"],
      "notify_email": "admin@example.com"
    },
    {
      "event_type": "user.remove",
      "note_title": "Alert: User Removed",
      "tags": ["security", "user-removal"],
      "notify_email": "admin@example.com"
    }
  ]
}
```

### Event Types Reference

The system can monitor these event endpoint types:

- **signinattempts** - User sign-in events (success and failed attempts)
- **auditevents** - Vault/item creation, modification, deletion, sharing
- **itemusages** - Item access events (when users view passwords)

To change which types are monitored, update the `OnePasswordEventTypes` parameter during stack deployment or update.

### Adjusting Poll Interval

To change how often events are checked:

1. Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
2. Select your stack
3. Click "Update"
4. Use current template
5. Change `PollIntervalMinutes` parameter
6. Complete the update

**Note**: Lower intervals mean faster detection but more Lambda invocations and costs.

## 🔒 Security Features

### Built-In Security

- ✅ **Encrypted Storage** - All S3 data encrypted with AWS KMS
- ✅ **Secrets Management** - API tokens stored in Secrets Manager
- ✅ **TLS in Transit** - All API calls use HTTPS
- ✅ **IAM Least Privilege** - Each Lambda has minimal required permissions
- ✅ **Private Bucket** - S3 bucket blocks all public access
- ✅ **Versioned Bucket** - S3 versioning enabled for data protection
- ✅ **CloudWatch Logs** - All Lambda executions logged (30-90 day retention)
- ✅ **No Hardcoded Secrets** - All credentials fetched at runtime

### Data Lifecycle

- **Active Storage**: Events stored in S3 Standard
- **90 Days**: Transitioned to S3 Standard-IA (lower cost)
- **365 Days**: Transitioned to Glacier (archival)
- **730 Days**: Automatically deleted

You can modify these timelines by editing the `LifecycleConfiguration` in the template.

## 📊 Monitoring & Troubleshooting

### CloudWatch Logs

**To view logs in the AWS Console:**

1. Go to [CloudWatch Console](https://console.aws.amazon.com/cloudwatch/)
2. Click "Log groups" in the left menu
3. Find and click on the log group:
   - `/aws/lambda/1password-event-poller-{env}` - Event polling
   - `/aws/lambda/1password-event-processor-{env}` - Alert processing
   - `/aws/lambda/1password-rules-uploader-{env}` - Rules deployment
4. Click on a log stream to view details

### Common Log Messages

**Successful poll:**
```
Starting 1Password event poll for types: ['signinattempts', 'auditevents', 'itemusages']
[signinattempts] Fetched 3 events.
Wrote 3 total events to S3: s3://bucket/events/2024/01/15/10-30-00.json
Invoked Processor for s3://bucket/events/...
```

**No new events:**
```
No new events from any type.
```

**Alert triggered:**
```
MATCH (signin): user@example.com at 2024-01-15T10:30:00Z
Created Secure Note: 'Security Alert: user@example.com Sign-In Detected [2024-01-15 10:30:00]'
Alert email sent to security@example.com
```

### S3 Event Archives

**To view archived events:**

1. Go to [S3 Console](https://console.aws.amazon.com/s3/)
2. Find your events bucket (check CloudFormation Outputs)
3. Navigate to `events/` folder
4. Events are organized by date: `events/YYYY/MM/DD/HH-MM-SS.json`
5. Download any file to view the full event data

### Event Archive Structure

```json
{
  "_metadata": {
    "fetched_at": "2024-01-15T10:30:00.123456+00:00",
    "total_events": 5,
    "event_type_counts": {
      "signinattempts": 2,
      "auditevents": 3
    }
  },
  "events": [
    {
      "uuid": "ABC123...",
      "timestamp": "2024-01-15T10:29:45Z",
      "type": "credentials_ok",
      "category": "success",
      "target_user": {
        "email": "user@example.com",
        "name": "John Doe",
        "uuid": "USER123..."
      },
      "location": {
        "city": "San Francisco",
        "region": "California",
        "country": "US"
      },
      "client": {
        "app_name": "1Password Browser Extension",
        "platform_name": "Chrome",
        "ip_address": "203.0.113.42"
      }
    }
  ]
}
```

### Checking SSM Cursors

**To view current polling positions:**

1. Go to [Systems Manager Console](https://console.aws.amazon.com/systems-manager/)
2. Click "Parameter Store" in the left menu
3. Look for parameters like:
   - `/1password-alert-system/{env}/cursors/signinattempts`
   - `/1password-alert-system/{env}/cursors/auditevents`
   - `/1password-alert-system/{env}/cursors/itemusages`
4. Click on a parameter to view its current value

The cursor is an opaque string that tracks the last-fetched event position for incremental polling.

## 🔄 Updates & Maintenance

### Update the Stack

**Using AWS Console:**
1. Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
2. Select your stack
3. Click "Update"
4. Choose "Replace current template"
5. Upload the updated template file
6. Review parameter changes
7. Click through to "Submit"

### Rotate API Tokens

**Events API Token:**
1. Generate a new token in 1Password (Settings → Events)
2. Go to [Secrets Manager Console](https://console.aws.amazon.com/secretsmanager/)
3. Find the secret `1password-events-bearer-token-{env}`
4. Click "Retrieve secret value"
5. Click "Edit"
6. Update the JSON: `{"token":"NEW_TOKEN_HERE"}`
7. Click "Save"

**Service Account Token:**
1. Issue a new token in 1Password (Settings → Service Accounts)
2. Go to [Secrets Manager Console](https://console.aws.amazon.com/secretsmanager/)
3. Find the secret `1password-sdk-service-account-token-{env}`
4. Click "Retrieve secret value"
5. Click "Edit"
6. Update the JSON: `{"token":"NEW_TOKEN_HERE"}`
7. Click "Save"

### Pause Monitoring

**To temporarily disable polling:**
1. Go to [EventBridge Console](https://console.aws.amazon.com/events/)
2. Click "Rules" in the left menu
3. Find the rule `1password-poll-schedule-{env}`
4. Click the rule name
5. Click "Disable"

**To re-enable:**
1. Follow steps 1-4 above
2. Click "Enable"

## 🗑️ Cleanup

To remove all resources:

**Using AWS Console:**

1. **Empty the S3 bucket first:**
   - Go to [S3 Console](https://console.aws.amazon.com/s3/)
   - Find your bucket (check CloudFormation Outputs)
   - Select all objects and versions
   - Click "Delete"
   - Confirm deletion

2. **Delete the CloudFormation stack:**
   - Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
   - Select your stack
   - Click "Delete"
   - Confirm deletion
   - Wait for deletion to complete (3-5 minutes)

## 📝 Cost Estimate

Monthly costs for typical usage (polling every 5 minutes, ~50 events/day, 1-2 alerts/day):

- **Lambda Invocations**: ~$0.50
  - Poller: 8,640 invocations/month
  - Processor: ~30 invocations/month
- **Lambda Duration**: ~$0.30
- **S3 Storage**: ~$0.05 (first month)
- **S3 Requests**: ~$0.05
- **CloudWatch Logs**: ~$0.20
- **SES**: $0.10 per 1,000 emails (~$0.01)
- **Secrets Manager**: ~$0.80 (2 secrets)
- **SSM Parameters**: Free

**Total**: ~$2-3/month

**Note**: Most services have free tier coverage for low usage. S3 storage costs grow over time until lifecycle policies move data to cheaper tiers.

## 🎯 Use Cases

### Security Monitoring
- Monitor executive/VIP account sign-ins
- Detect unusual sign-in patterns
- Track vault creation/deletion
- Alert on user additions/removals

### Compliance & Auditing
- Maintain tamper-proof event logs
- Generate audit trails for compliance reviews
- Track item access patterns
- Document security incidents

### Operational Awareness
- Monitor shared vault modifications
- Track password rotations
- Alert on policy changes
- Detect service account usage

## 🔧 Advanced Configuration

### Custom Event Processing

To add custom logic to the Processor Lambda:

1. Download the current template
2. Edit the `ProcessorFunction` → `Code` → `ZipFile` section
3. Modify the `match_events()` function or add new processing logic
4. Update the stack with the modified template

### Multiple Environments

Deploy separate stacks for dev/staging/prod:

1. Deploy the stack multiple times with different stack names
2. Set the `Environment` parameter to `dev`, `staging`, or `prod` for each deployment
3. Each environment gets isolated resources (separate S3 buckets, Lambda functions, etc.)

Example naming:
- Stack name: `1password-monitoring-dev` with Environment: `dev`
- Stack name: `1password-monitoring-prod` with Environment: `prod`

### Custom Alert Rules via S3

For complex alerting logic:

1. Create a custom rules file with additional conditions
2. Upload to S3 at `rules/alert_rules.json`
3. Modify the Processor's `match_events()` function to handle new rule types

## 📚 Additional Resources

- [1Password Events API Documentation](https://developer.1password.com/docs/events-api/)
- [1Password Python SDK Documentation](https://developer.1password.com/docs/sdks/python/)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [AWS CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)

## 🆘 Support

For issues or questions:

1. Check CloudWatch Logs for Lambda execution errors
2. Verify all API tokens are valid and not expired
3. Confirm SES sender email is verified
4. Review S3 bucket for event archives to verify polling is working
5. Check SSM parameters to ensure cursors are being updated
6. Verify the vault ID is correct and service account has access

---

**Happy Monitoring! 🔐**