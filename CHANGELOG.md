# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-02

### Added

- A notification when `/clear` waits for the agent to become idle before clearing.

### Changed

- Restore the captured thinking level as-is instead of validating against a hardcoded list of levels, so levels pi adds later are preserved rather than silently dropped.

## [0.1.1] - 2026-10-02

### Fixed

- Corrected the package name in install instructions (`@grrrck`, not `@gadenbuie`).

## [0.1.0] - 2026-10-02

### Added

- `/clear` command that starts a fresh session while preserving the current model and thinking level.
- Waits for the agent to become idle before clearing.
- Warnings when clearing is cancelled, the model is no longer available, or its auth is missing.
