# 0011: Files and attachments

Status: proposed (2026-11-17). Not built. Open for discussion before any code is written.

## Context

People will want to attach files to records: a résumé on a candidate, a signed contract on a deal, a photo on a property. hl-crm-db is self-hosted and Postgres-only, and it runs multi-tenant with forced row-level security. Every value has to be checked against object and field access, including `restricted`, which is encrypted and needs `restricted:read`. The API refuses request bodies over 1 MB. The server already has a small local blob store (`BLOB_DIR`), which it uses for export files. A hosted service is planned to run the same code. Whatever is chosen must also work in exports, imports, merges and erasure.

## Options for where the bytes live

1. **In Postgres** (`bytea` in a `files` table, or large objects). One backup covers everything, row-level security applies to the bytes themselves, and a transaction covers the record and its file. But every byte goes through the pool and the WAL, backups and replicas grow with the files, and large objects sit outside row-level security (`pg_largeobject` has no tenant column), so they would need their own guard. Workable for small files (up to a few MB) and small workspaces.
2. **The existing local blob store** (a directory on the server). Simple, and no extra service. But it is not shared between API processes or hosts, it is not in the database backup unless the operator copies it too, and tenant separation is only in our code (paths), not in the database.
3. **S3-compatible object storage** (AWS S3, MinIO, Cloudflare R2, Backblaze B2). It scales and backs up apart from the database, and would suit a hosted service. But it is one more thing a self-hoster must run or rent, and isolation rests on key naming and on our checks, since the store knows nothing about tenants.

**Suggested:** an interface `FileStore { put, get, delete, signedGet? }` with two implementations: Postgres `bytea` as the default (self-hosting needs nothing new), and S3-compatible as an option (`FILE_STORE=s3`). Metadata always lives in Postgres under row-level security, whatever holds the bytes.

## The rest of the design

- **Model.** A `file` field type whose value is a list of file references: `{id, name, size, content_type, sha256, uploaded_at}`. A `files` table (forced RLS) holds those references plus the record and field each belongs to and the storage key. Bytes are never in the record JSON.
- **Size limits.** Uploads can't fit in the 1 MB JSON body limit, so they need their own route: `PUT /v1/files` with a raw body and its own limit (suggested default 10 MB, set by the operator), streamed with a running hash and size check. Add a per-workspace quota, and a per-field limit on files per value. The 1 MB limit for everything else stays.
- **Permission on download.** `GET /v1/files/{id}` checks the caller's access to the record's object and field each time (`fieldAccess`), and `restricted:read` for a restricted field. Knowing a file ID gives nothing. Downloads are audited, at least for restricted fields. An upload not attached to a record within an hour is removed.
- **Signed URLs.** Optional, short-lived (5 minutes), for browsers and for S3 direct download. They are issued only after the permission check, bound to one file and one credential, and listed in the audit log. With Postgres storage the server streams the file itself, so no signed URL is needed.
- **Virus scanning.** A hook rather than a built-in scanner: uploads stay `pending` until a configured scanner (ClamAV over its socket, or a webhook to a scanning service) says `clean`. Without a scanner they are marked `unscanned` and served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, never inline. Content types are sniffed, not trusted.
- **Encryption.** Restricted files are encrypted per file with the workspace data key (AES-GCM, the same envelope as restricted values), whatever the store. On S3, server-side encryption is added on top, not relied on.
- **Export and import.** A CSV export writes file names and IDs, never bytes. A separate `crm data export-files` bundles the files a caller can read into a zip with a manifest. Import takes file IDs already uploaded to the same workspace, never URLs, so the server never fetches from outside (no SSRF).
- **Merge.** The survivor keeps its files, and the duplicates' files are added to the list (a merge already treats list fields as values; file lists would be the documented exception, to avoid losing documents). Duplicates' references stay in the merge record, for unmerge.
- **Erasure and retention.** `erase_contact` deletes files on the contact's confidential and restricted fields. Archiving a record keeps its files. Deleting a workspace deletes its bytes in the store too, which S3 needs a sweep for.
- **Schema packs** can declare file fields, but never carry files.

## Open questions

1. Postgres-by-default plus optional S3, or S3 only?
2. Default upload limit and per-workspace quota?
3. Is a missing virus scanner acceptable for self-hosting (files served as downloads only), or should uploads be refused without one?
4. Should merges combine file lists (the suggestion) or follow the survivor-wins rule like other lists?
