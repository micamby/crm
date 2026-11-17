# Subprocessors and third-party services (planning notes for a hosted service)

**These are planning notes for a future hosted service, which does not exist yet. The open source project makes no compliance claim, and no customer data is processed by anyone on this list today.** The table is a draft of what a hosted service would use.

| Service | Purpose | Customer data access | Status |
|---|---|---|---|
| Amazon Web Services (us-east-2) | Hosting: compute, database, key management, storage, email (SES) | Stores and processes all customer data | Planned |
| GitHub | Source code, CI | None (no customer data in the repository or CI) | In use |

Self-hosted deployments use none of these unless the operator chooses to.
