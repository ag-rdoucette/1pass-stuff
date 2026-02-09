# 🔐 Secure 1Password Item Creator

A serverless AWS application that provides a web interface for creating 1Password vault items with **client-side encryption**. All sensitive data is encrypted in the browser using hybrid RSA-2048 + AES-256-GCM before transmission — AWS administrators and network observers never see plaintext secrets.

## Architecture

```
┌─────────────┐     HTTPS      ┌──────────────┐      S3 (OAC)      ┌────────────┐
│   Browser   │ ──────────────▶│  CloudFront   │ ──────────────────▶│  S3 Bucket │
│  (encrypts) │                │  + Security   │                    │  (static)  │
└──────┬──────┘                │    Headers    │                    └────────────┘
       │                       └──────┬────────┘
       │  POST /api/create            │  /api/*
       │  (encrypted payload)         │
       ▼                              ▼
┌──────────────┐              ┌──────────────┐
│  API Gateway │ ────────────▶│    Lambda     │
│  (Regional)  │              │ ItemCreator   │
└──────────────┘              └──────┬────────┘
                                     │
                              ┌──────┴────────┐
                              │               │
                       ┌──────▼──────┐ ┌──────▼──────┐
                       │  Secrets    │ │  1Password  │
                       │  Manager    │ │  SDK API    │
                       │ (RSA key +  │ └─────────────┘
                       │  OP token)  │
                       └─────────────┘
```

## Features

- **Client-side hybrid encryption** — RSA-2048 wraps a random AES-256-GCM key; data is encrypted entirely in the browser
- **9 item categories** — Login, Secure Note, Credit Card, API Credentials, Database, Server, Router, Software License, Document
- **File attachments** — Upload documents and file attachments (5 MB limit)
- **Tags** — Add arbitrary tags to any item
- **WAF integration** — Optional IP allowlisting with rate limiting (100 req/IP/5 min)
- **Custom domain** — Optional CloudFront alias with ACM certificate and Route 53 DNS
- **KMS encryption** — All secrets encrypted at rest with a dedicated CMK (scoped key policy)
- **Security headers** — HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, XSS-Protection via CloudFront response headers policy
- **Origin-locked CORS** — When a custom domain is configured, CORS is restricted to that origin only
- **Minimal IAM** — Each Lambda has its own least-privilege role

## Prerequisites

- **AWS CLI** configured with appropriate permissions
- **1Password Service Account Token** with write access to the target vault
- **1Password Vault UUID** (26-character lowercase alphanumeric ID)

## Deployment

### 1. Deploy the CloudFormation Stack

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name secure-item-creator \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OPServiceAccountToken="ops_XXXXX..." \
    TargetVaultID="abcdefghijklmnopqrstuvwxyz"
```

**Optional parameters:**

| Parameter | Default | Description |
|---|---|---|
| `AllowedIPRanges` | `0.0.0.0/0` | CIDR ranges for WAF allowlist (comma-separated) |
| `CustomDomainName` | *(empty)* | Custom domain for CloudFront (e.g., `items.example.com`) |
| `AcmCertificateArn` | *(empty)* | ACM certificate ARN in `us-east-1` |
| `CreateRoute53Record` | `false` | Auto-create Route 53 alias record |
| `Route53HostedZoneId` | *(empty)* | Hosted zone ID (required if creating DNS record) |
| `LambdaMemory` | `1024` | Lambda memory in MB (512–10240) |
| `LambdaTimeout` | `300` | Lambda timeout in seconds (60–900) |
| `StageName` | `prod` | API Gateway stage (`dev`, `staging`, `prod`) |

### 2. Upload the Frontend

```bash
# Get the S3 bucket name from stack outputs
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name secure-item-creator \
  --query 'Stacks[0].Outputs[?OutputKey==`S3BucketName`].OutputValue' \
  --output text)

# Upload
aws s3 cp index.html s3://$BUCKET/

# Invalidate CloudFront cache
DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name secure-item-creator \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
  --output text)

aws cloudfront create-invalidation --distribution-id $DIST_ID --paths '/*'
```

### 3. Access the Application

The website URL is in the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name secure-item-creator \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteURL`].OutputValue' \
  --output text
```

## How It Works

### Encryption Flow

1. **Page load** — The browser fetches the RSA-2048 public key from `/api/publickey`
2. **Form submission** — The browser:
   - Generates a random 256-bit AES-GCM key
   - Encrypts the JSON payload with AES-GCM
   - Wraps the AES key with RSA-OAEP (SHA-256)
   - Packs everything into `[key_length (4B)][encrypted_key][iv (12B)][ciphertext]`
   - Base64-encodes and sends to `/api/create`
3. **Lambda processing** — The ItemCreator Lambda:
   - Retrieves the RSA private key from Secrets Manager (KMS-encrypted)
   - Unwraps the AES key with RSA-OAEP
   - Decrypts the payload with AES-GCM
   - Creates the item via the 1Password SDK
   - Returns a generic error on failure (details logged server-side only)

### Key Generation

An RSA-2048 keypair is generated automatically during stack creation by a custom CloudFormation resource (`KeyGeneratorLambda`). The private key is stored in Secrets Manager, encrypted with the stack's KMS CMK. The public key is served to browsers via the `GetPublicKeyLambda`.

## Stack Resources

| Resource | Purpose |
|---|---|
| **KMS Key** | Encrypts secrets at rest (scoped key policy) |
| **Secrets Manager** (×2) | Stores 1Password token and RSA keypair |
| **S3 Bucket** | Hosts the static frontend (versioned, encrypted, origin-locked CORS) |
| **CloudFront** | CDN with OAC, HTTPS enforcement, HTTP/2+3, security headers |
| **Response Headers Policy** | HSTS, CSP, X-Frame-Options, X-Content-Type-Options, XSS-Protection |
| **API Gateway** | Regional REST API with two endpoints |
| **Lambda** (×3) | Key generator, public key server (warm-cached), item creator |
| **WAF** *(conditional)* | IP allowlisting + rate limiting |
| **Route 53** *(conditional)* | DNS alias record for custom domain |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/publickey` | Returns the RSA public key (PEM). Cached in-Lambda across warm invocations. |
| `POST` | `/api/create` | Accepts `{ encryptedPayload: "<base64>" }`. Returns generic errors on failure. |

Both endpoints support CORS via `OPTIONS` preflight. When a custom domain is configured, the `Access-Control-Allow-Origin` header is locked to that domain.

## Supported Item Categories

| Category | Required Fields | Optional Fields |
|---|---|---|
| **Login** | password | username, URL, notes |
| **Secure Note** | note content | tags |
| **Credit Card** | card number | cardholder, type, CVV, expiry, contact info, PIN, limits |
| **API Credentials** | credential | username, type, hostname, notes |
| **Database** | hostname | type, port, database, username, password, SID, alias |
| **Server** | *(none)* | URL, username, password, admin console, hosting provider |
| **Router** | password | base station name, server/IP, notes |
| **Software License** | license key | version, notes |
| **Document** | file attachment | notes |

## Security Features

### What's Protected

- All sensitive field values are encrypted client-side before leaving the browser
- The 1Password service account token is stored in Secrets Manager with KMS encryption
- The RSA private key never leaves Secrets Manager
- CloudFront enforces HTTPS with HSTS (2-year max-age, includeSubdomains, preload)
- S3 is not publicly accessible (OAC only)
- Content Security Policy prevents XSS and restricts resource loading
- `X-Frame-Options: DENY` prevents clickjacking
- KMS key policy is scoped to administration and Secrets Manager usage (no blanket `kms:*`)
- Error responses to clients are generic; details are logged to CloudWatch only
- GetPublicKey Lambda caches the public key in-memory across warm invocations to minimize Secrets Manager calls

### CORS Behavior

When `CustomDomainName` is set, CORS is locked to `https://<your-domain>` across S3 bucket policy, API Gateway OPTIONS responses, and Lambda response headers. Without a custom domain, CORS defaults to `*` (suitable for development with the CloudFront-generated domain).

### Future Improvements

- **Lambda layers** — Package `onepassword-sdk` and `cryptography` in a Lambda layer or container image to eliminate runtime pip installs, reducing cold start time and supply-chain surface
- **RSA-4096 or ECDH** — Consider upgrading from RSA-2048 for long-lived deployments
- **API authentication** — Add API keys or a Cognito authorizer for defense-in-depth beyond encryption + WAF
