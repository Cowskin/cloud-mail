# happyx2 D1 backups

This Worker runs a Cloudflare Workflow every Sunday at 12:00 Asia/Shanghai
(Sunday 04:00 UTC). It exports `cloud-mail-db`, compresses the SQL stream with
gzip, and stores it under `weekly/YYYY-MM-DD/` in the private
`happyx2-mail-backups` R2 bucket.

The `D1_REST_API_TOKEN` secret must have permission to export the target D1
database. Never store that token in this repository.
