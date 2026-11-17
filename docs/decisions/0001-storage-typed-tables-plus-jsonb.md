# 0001: Typed tables for standard objects, JSONB for custom data

Status: accepted (2026-10-30)

## Context

Standard objects need typed core columns. Tenants also need to add fields and objects at runtime, and DDL must never be driven by customer input.

## Decision

- Standard objects (Contact, Account, Lead, Deal, …) have typed tables created by migrations, plus a `custom jsonb` column for each tenant's own fields.
- Custom objects live in one `records` table (`data jsonb`).
- Restricted values are stored encrypted in `custom_encrypted` or `encrypted`.
- Every record is registered in `record_registry`, so polymorphic links (activity and task associations, custom relations in `record_links`) have real foreign keys.
- Field values in JSON are keyed by an immutable `storage_key`, so renaming a field touches only metadata.

## Consequences

- Money, statuses and relations between standard objects get database constraints.
- Custom fields are validated by the service layer from metadata. Uniqueness is enforced under an advisory lock; partial unique indexes are deferred until a tenant needs them.
- Queries on custom fields use expression casts over JSONB, with GIN indexes. This is enough for the year-1 scale of about 1 million rows per tenant.
