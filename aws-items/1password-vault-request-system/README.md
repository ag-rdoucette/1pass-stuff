# 1Password Vault Request & Approval System

A serverless AWS application that provides a secure, web-based workflow for requesting and approving new 1Password vaults with granular permission management.

## 🎯 Overview

This system enables users to submit vault requests through a web form, which are then sent to designated approvers via email. Upon approval, vaults are automatically created in 1Password with the requested permissions for users and groups.

### Key Features

- **📝 Web-Based Request Form** - User-friendly interface for submitting vault requests
- **✉️ Email Approval Workflow** - Approvers receive formatted emails with one-click approve/deny links
- **🔐 Automated Vault Creation** - Approved vaults are created automatically using 1Password CLI
- **👥 Granular Permissions** - Assign custom permissions to users and groups
- **🌐 CloudFront Distribution** - Fast, global content delivery with optional custom domain
- **🛡️ Security Features** - WAF, IP restrictions, rate limiting, HTTPS, and encrypted secrets
- **📊 DynamoDB Storage** - Request tracking with automatic expiration (TTL)
- **🔄 SQS Queue** - Reliable vault creation with retry capability
- **📧 SES Notifications** - Automated emails to requesters and approvers

## 🏗️ Architecture

```
User → CloudFront → S3 (Web Form)
                 → API Gateway → Lambda (Submit Request) → DynamoDB
                                                         → SES (Email Approver)

Approver → Email Link → API Gateway → Lambda (Approval Handler) → DynamoDB
                                                                 → SQS Queue
                                                                 → SES (Notify Requester)

SQS Queue → Lambda (Vault Creator) → 1Password CLI → Vault Created
                                    → SES (Final Notification)
```

## 📋 Prerequisites

Before deploying this system, you need:

1. **AWS Account** with appropriate permissions
2. **1Password Service Account Token** ([Get one here](https://start.1password.com/integrations/directory))
3. **AWS SES Verified Email** (sender email must be verified in SES)
4. **(Optional) Custom Domain** with ACM certificate in `us-east-1`
5. **(Optional) Route53 Hosted Zone** for automatic DNS configuration

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
3. Upload the `1password-vault-request-system.yaml` template file
4. Click "Next"
5. Enter a stack name (e.g., `1password-vault-system`)
6. Fill in the required parameters:
   - **OPServiceAccountToken**: Your 1Password service account token
   - **ApproverEmail**: Email that receives approval requests
   - **SenderEmail**: Your SES-verified sender email
7. Configure optional parameters as needed
8. Click "Next" through the remaining screens
9. Check "I acknowledge that AWS CloudFormation might create IAM resources with custom names"
10. Click "Submit"

**Wait for stack creation to complete** (5-10 minutes). The stack status will change to `CREATE_COMPLETE`.

### Step 2: Get Your CloudFront URL

1. In the CloudFormation Console, select your stack
2. Click the "Outputs" tab
3. Copy the value for `WebsiteURL` - this is your CloudFront URL

### Step 3: Upload the Web Form

1. **Update the HTML file** with your CloudFront URL:
   - Open `index.html` in a text editor
   - Find the line: `const CLOUDFRONT_URL = 'https://YOUR-CLOUDFRONT-URL.cloudfront.net';`
   - Replace with your actual CloudFront URL from Step 2
   - Save the file

2. **Upload to S3**:
   - Go to [S3 Console](https://console.aws.amazon.com/s3/)
   - Find your bucket (name is in CloudFormation Outputs as `S3BucketName`)
   - Click "Upload"
   - Drag and drop `index.html` or click "Add files"
   - Click "Upload"

3. **Trigger user/group export** (populates dropdown lists):
   - Go to [Lambda Console](https://console.aws.amazon.com/lambda/)
   - Find the function named `*-UserGroupExportLambda`
   - Click "Test" tab
   - Create a new test event (any name, default JSON is fine)
   - Click "Test" to invoke the function
   - Verify it completes successfully

4. **Invalidate CloudFront cache**:
   - Go to [CloudFront Console](https://console.aws.amazon.com/cloudfront/)
   - Click on your distribution (ID is in CloudFormation Outputs)
   - Click "Invalidations" tab
   - Click "Create invalidation"
   - Enter `/*` as the path
   - Click "Create invalidation"

### Step 4: Test the System

1. Open the CloudFront URL in your browser
2. Fill out a test vault request
3. Approver receives an email with approve/deny links
4. Click approve → Vault is created automatically in 1Password

## ⚙️ Configuration Options

### Required Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `OPServiceAccountToken` | 1Password service account token | `ops_xxx...` |
| `ApproverEmail` | Email that receives approval requests | `approver@example.com` |
| `SenderEmail` | SES-verified sender email | `noreply@example.com` |

### Optional Security Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `AllowedIPsCidr` | Comma-separated IP CIDR blocks | Empty (no restriction) |
| `WafWebAclArn` | Existing WAF WebACL ARN | Empty |
| `ApprovalTokenTTLDays` | Days until approval links expire | 7 |

### Optional Custom Domain Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `CustomDomainName` | Custom domain (e.g., vaults.example.com) | Empty |
| `AcmCertificateArn` | ACM certificate ARN (must be in us-east-1) | Empty |
| `CreateRoute53Record` | Auto-create DNS record? | false |
| `Route53HostedZoneId` | Route53 Hosted Zone ID | Empty |

### Advanced Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `OPCliVersion` | 1Password CLI version | 2.32.0 |
| `StageName` | API Gateway stage | prod |
| `SubmitApprovalMemory` | Lambda memory (MB) | 256 |
| `CreatorMemory` | Vault Creator memory (MB) | 512 |

## 🔒 Security Features

### Built-In Security

- ✅ **HTTPS Only** - All traffic encrypted with TLS 1.2+
- ✅ **Secrets Manager** - 1Password token encrypted at rest
- ✅ **IAM Least Privilege** - Each Lambda has minimal required permissions
- ✅ **DynamoDB Encryption** - Server-side encryption enabled
- ✅ **S3 Private** - Bucket accessed only via CloudFront OAC
- ✅ **Point-in-Time Recovery** - DynamoDB backup enabled
- ✅ **CloudWatch Logs** - All Lambda execution logged (30-day retention)
- ✅ **Rate Limiting** - API Gateway throttling (20 requests/sec)
- ✅ **Approval Token Expiration** - Time-limited approval links

### Optional Security Enhancements

**IP Whitelisting** - Restrict access to specific IP ranges:
- In CloudFormation parameters, set `AllowedIPsCidr` to comma-separated CIDR blocks
- Example: `10.0.0.0/8,203.0.113.0/24`

**Custom WAF** - Use an existing WAF WebACL:
- In CloudFormation parameters, set `WafWebAclArn` to your WAF ARN
- Example: `arn:aws:wafv2:us-east-1:123456789012:global/webacl/...`

## 🎨 Customization

### Permission Presets

The web form includes three built-in permission presets:

- **📖 Read-Only**: `view_items`, `view_and_copy_passwords`
- **✏️ Editor**: Read-Only + `create_items`, `edit_items`, `archive_items`
- **👑 Manager**: Editor + `delete_items`, `view_item_history`, `import_items`, `copy_and_share_items`, `manage_vault`

Users can also create custom permission combinations via the modal dialog.

### Email Templates

Email templates are embedded in the Lambda functions. To customize:

1. Update the `SubmitRequestLambda` code in the CloudFormation template
2. Modify the HTML/text email bodies
3. Update the stack with `aws cloudformation update-stack`

### Web Form Styling

Edit `index.html` to customize colors, fonts, and layout. All styling is self-contained in the `<style>` section.

## 📊 Monitoring & Troubleshooting

### CloudWatch Logs

**To view logs in the AWS Console:**
1. Go to [CloudWatch Console](https://console.aws.amazon.com/cloudwatch/)
2. Click "Log groups" in the left menu
3. Find and click on the log group you want to view:
   - `/aws/lambda/*-SubmitRequestLambda` - Request submissions
   - `/aws/lambda/*-VaultCreatorLambda` - Vault creation
   - `/aws/apigateway/*` - API Gateway requests
4. Click on a log stream to view details

### DynamoDB Requests Table

**To view requests in the AWS Console:**
1. Go to [DynamoDB Console](https://console.aws.amazon.com/dynamodb/)
2. Click "Tables" in the left menu
3. Click on your requests table (named `*-Requests`)
4. Click "Explore table items" to view all requests
5. Use filters to search for specific requests by RequestId or Status

### SQS Queue

**To check queue status in the AWS Console:**
1. Go to [SQS Console](https://console.aws.amazon.com/sqs/)
2. Click on your queue (named `*-ApprovalQueue`)
3. View "Messages available" metric to see pending vault creations
4. Click "Send and receive messages" to inspect individual messages

## 🔄 Updates & Maintenance

### Update the Stack

**Using AWS Console:**
1. Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
2. Select your stack
3. Click "Update"
4. Choose "Replace current template"
5. Upload the updated template file
6. Click "Next" and review parameter changes
7. Click through to "Submit"

### Rotate 1Password Token

**Using AWS Console:**
1. Go to [Secrets Manager Console](https://console.aws.amazon.com/secretsmanager/)
2. Find the secret named `*-OPServiceToken`
3. Click "Retrieve secret value"
4. Click "Edit"
5. Replace the secret value with your new token
6. Click "Save"

### Manual User/Group Export

**Using AWS Console:**
1. Go to [Lambda Console](https://console.aws.amazon.com/lambda/)
2. Find the function named `*-UserGroupExportLambda`
3. Click "Test" tab
4. Create or select a test event
5. Click "Test" to invoke the function
6. Check the execution result for success

## 🗑️ Cleanup

To remove all resources:

**Using AWS Console:**

1. **Empty the S3 bucket first:**
   - Go to [S3 Console](https://console.aws.amazon.com/s3/)
   - Find your bucket (check CloudFormation Outputs for `S3BucketName`)
   - Select all objects
   - Click "Delete"
   - Confirm deletion

2. **Delete the CloudFormation stack:**
   - Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
   - Select your stack
   - Click "Delete"
   - Confirm deletion
   - Wait for deletion to complete (5-10 minutes)

## 📝 Cost Estimate

Monthly costs for moderate usage (~100 requests/month):

- **Lambda**: ~$0.20
- **API Gateway**: ~$0.35
- **DynamoDB**: ~$0.25 (on-demand)
- **S3**: ~$0.05
- **CloudFront**: ~$1.00
- **SES**: $0.10 per 1,000 emails
- **CloudWatch Logs**: ~$0.50
- **Secrets Manager**: ~$0.40

**Total**: ~$2.85/month (excluding custom domain/WAF)

**Note**: Most services have free tier coverage for low usage.

## 🆘 Support

For issues or questions:

1. Check CloudWatch Logs for Lambda execution errors
2. Verify SES sender email is verified
3. Confirm 1Password service account has correct permissions
4. Review DynamoDB table for request status
5. Check SQS queue for failed messages

## 🔗 Useful Links

- [1Password Service Accounts](https://developer.1password.com/docs/service-accounts)
- [1Password CLI Documentation](https://developer.1password.com/docs/cli)
- [AWS SES Documentation](https://docs.aws.amazon.com/ses/)
- [CloudFormation Best Practices](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/best-practices.html)