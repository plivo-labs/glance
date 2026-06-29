# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:
**Security tab → "Report a vulnerability"**
(direct link: `https://github.com/plivo-labs/glance/security/advisories/new`)

Include:
- Description of the vulnerability and potential impact
- Steps to reproduce or a minimal proof-of-concept
- Affected component (API worker, content worker, web frontend, CLI)

We aim to acknowledge reports within 2 business days and provide a fix timeline within 7 days.

## Scope notes

Glance handles sensitive surface areas — please pay particular attention to:

- **OAuth flow** — Google OAuth state parameter, callback validation
- **Session tokens** — signed cookies, session invalidation
- **HMAC upload tokens** — token forgery, replay attacks
- **R2/D1 access controls** — unauthorised read/write to buckets or database
- **Path traversal** — content worker serving arbitrary R2 keys
