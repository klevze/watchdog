# Changelog

All notable changes to this project are documented in this file.

## [1.0.0] - 2025-08-21

### Added

- Publish package as `watchdog` with CLI entrypoint `watchdog` (previously `watch-uploader`).
- `--dry-run` flag to preview actions without changing remote state.
- `--auth key|password` option and environment-variable fallbacks: `WATCHDOG_PRIVATE_KEY`, `WATCHDOG_PASSWORD`.
- Startup SFTP permission check: verifies the tool can list, write and remove a small file in `remoteBaseDir` and fails early on permission errors.
- Expanded unit test coverage for auth selection, large-file detection, dry-run ops, connect logic, and SFTP permission checks.

### Changed

- Consolidated runtime dependencies and updated packaging (`files` field and `.npmignore`).
- Improved CLI logging, colors, and an ASCII startup banner.

### Notes / Migration

- If you previously invoked `watch-uploader`, update automation to call `watchdog` instead.
- For CI, prefer `WATCHDOG_PASSWORD` or `WATCHDOG_PRIVATE_KEY` to avoid committing secrets in config.

---

_Unreleased changes go above._
