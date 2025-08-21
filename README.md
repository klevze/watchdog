# Watchdog

A cross-platform file watcher and uploader (SFTP by default) for automated deployment. Optional transports include S3, FTPS, WebDAV, and tus.

## Features

- Watches local files and folders for changes
- Uploads changes to remote targets via multiple transports (SFTP, S3, Azure Blob, Google Cloud Storage, FTPS/FTP, WebDAV, tus)
- Supports ignore patterns (minimatch syntax)
- Dry-run mode for safe testing
- Configurable concurrency, debounce, and file size limits
- Initial sync option
- Colored output and logging levels
- Log level controls: --silent, --verbose, and --log-level with clear precedence
- Safety guards to prevent remote operations outside the configured base path; optional --strict-delete to fail fast
- Graceful shutdown with a stats summary

## Installation

### Prerequisites

- Node.js v16 or newer (<https://nodejs.org/>)
- SSH/SFTP access to your remote server (default)
- For S3 transport, Node.js v18+ is required by AWS SDK v3

### Windows

```powershell
# Open PowerShell and run:
git clone https://github.com/klevze/watchdog.git
cd watchdog
npm install
```

## Quick start

1) Create a minimal config file (SFTP example) as `watchdog.config.json`:

```json
{
  "sourceDir": "./dist",
  "server": {
    "type": "sftp",
    "host": "example.com",
    "username": "deploy",
    "privateKey": "C:/Users/you/.ssh/id_rsa",
    "remoteBaseDir": "/var/www/myproject"
  },
  "ignore": [".git", "node_modules", "**/*.log"],
  "concurrency": 2,
  "debounceMs": 500
}
```

1) Run the watcher:

```powershell
watchdog --config .\watchdog.config.json
```

## Transports

- Default: SFTP (ssh2-sftp-client) — requires server host/username and either privateKey or password
- S3: set `server.type` to `"s3"`, provide `bucket` and `region`; credentials via env/shared config. Supports S3-compatible endpoints via `endpoint` and `forcePathStyle` (e.g., MinIO, Cloudflare R2, Backblaze B2).
- Azure Blob Storage: set `server.type` to "azure", provide `container` and either `connectionString`, or `accountName` with `accountKey` or `sasToken`
- Google Cloud Storage: set `server.type` to "gcs", provide `bucket`, and auth via `keyFilename`, inline `credentials`, or ADC (`GOOGLE_APPLICATION_CREDENTIALS`)
- FTPS: set `server.type` to `"ftps"`, uses basic-ftp
- FTP: set `server.type` to `"ftp"` (non-TLS), uses basic-ftp
- WebDAV: set `server.type` to `"webdav"`
- tus: set `server.type` to `"tus"` for resumable uploads

See `watchdog.sample.config.jsonc` for examples.

### Optional transport dependencies

Only install what you use. Transports are lazily loaded, and their packages are optional:

- S3: `@aws-sdk/client-s3` (already included)
- Azure Blob Storage: `@azure/storage-blob`
- Google Cloud Storage: `@google-cloud/storage`
- FTPS/FTP: `basic-ftp`
- WebDAV: `webdav`
- tus: `tus-js-client`

These are required only when the corresponding `server.type` is selected.

### Adapter limitations

- S3: directory create/remove are no-ops; delete maps to DeleteObject; requires Node 18+
- Azure: directory create/remove are no-ops; delete is best-effort deleteIfExists; credentials via connection string, account key, or SAS
- GCS: directory create/remove are no-ops; delete uses file.delete(); auth via key file, inline credentials, or ADC
- FTPS: delete/rmdir best-effort via basic-ftp
- FTP: delete/rmdir best-effort via basic-ftp; not encrypted
- WebDAV: rmdir implemented as file deletion; semantics depend on server
- tus: delete is not supported (uploads only)

### Example transport configs

Azure Blob Storage:

```json
{
  "server": {
    "type": "azure",
    "container": "my-container",
    "connectionString": "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
  }
}
```

Plain FTP:

```json
{
  "server": {
    "type": "ftp",
    "host": "ftp.example.com",
    "username": "user",
    "password": "pass",
    "remoteBaseDir": "/var/www/site"
  }
}
```

S3-compatible (MinIO/R2/B2):

```json
{
  "server": {
    "type": "s3",
    "bucket": "my-bucket",
    "region": "us-east-1",
    "endpoint": "http://localhost:9000",
    "forcePathStyle": true
  }
}

Google Cloud Storage:

```json
{
  "server": {
    "type": "gcs",
    "bucket": "my-bucket",
    "projectId": "my-gcp-project",
    "keyFilename": "./gcp-service-account.json"
  }
}
```

## CLI

Basic:

```bash
watchdog --config path/to/config.json
```

Options:

| Option | Description | Notes |
|-------|-------------|-------|
| `--config <path>` | Path to config file | Default: `watchdog.config.json` |
| `--dry-run` | Do not modify remote, only log actions | Safe for testing |
| `--concurrency <n>` | Parallel uploads/delete workers | Overrides config `concurrency` |
| `--auth key\|password` | Force SFTP auth mode | Overrides config; supports env fallbacks |
| `--verbose` | Enable debug logging | Forces debug level |
| `--silent` | Errors only | Highest precedence |
| `--log-level <level>` | Set log level: error, warn, info, debug | Precedence: silent > verbose > log-level > config |
| `--strict-delete` | Exit immediately on unsafe delete/rmdir | Safety fail-fast |
| `--version` | Print version and exit | |
| `-h, --help` | Show help | |

### Log level precedence

When multiple flags/settings are provided, the effective log level is chosen with this precedence (highest wins):

1. `--silent` (forces `error` only)
2. `--verbose` (forces `debug`)
3. `--log-level` (explicit level)
4. `config.logLevel` (default)

## Authentication

Supported methods (preference order):

1. `server.privateKey` (config) — private key path (recommended)
2. `server.password` (config)
3. `WATCHDOG_PRIVATE_KEY` (env) — path or key content
4. `WATCHDOG_PASSWORD` (env)

Environment variables are useful for CI and avoid committing secrets to the repo.

## Testing

Install dev dependencies and run tests:

```bash
npm install --save-dev mocha chai
npm test
```

## Troubleshooting

- Use `--dry-run` to verify actions without modifying the remote
- Check SSH key permissions and remote directory ownership
- Reduce `concurrency` or increase `debounceMs` if uploads fail under load
- If SFTP permission test fails at startup, verify credentials and `remoteBaseDir`

## Example server config

```json
{
  "server": {
    "host": "example.com",
    "username": "deploy",
    "privateKey": "c:/users/you/.ssh/id_rsa",
    "remoteBaseDir": "/var/www/myproject"
  }
}
```

## Changelog / Migration (v1.0.0)

- Rename: package now publishes as `watchdog` and the CLI entrypoint is `watchdog` (previously `watch-uploader`).
- New: `--dry-run` flag to preview actions without changing remote state.
- New: `--auth key|password` option and environment-variable fallbacks: `WATCHDOG_PRIVATE_KEY`, `WATCHDOG_PASSWORD`.
- New: Startup SFTP permission check — the tool will verify it can list, write and remove a small file in `remoteBaseDir` and will fail early on permission errors.
- Tests: expanded unit test coverage for auth selection, large-file detection, dry-run ops, and SFTP permission checks.

### Migration notes

- If you previously installed a CLI named `watch-uploader`, update any automation to call `watchdog` instead.
- Provide authentication via `server.privateKey` (path) or `WATCHDOG_PRIVATE_KEY`. For CI, use `WATCHDOG_PASSWORD` to avoid storing secrets in the config file.

## License

MIT
