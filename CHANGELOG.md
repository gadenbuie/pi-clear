# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Model handoff now uses in-process memory (`globalThis`) instead of a temp file, removing cross-process interference, stale-file pickup, and symlink-based tampering risks.
- Handoffs are consumed once, cleared when `/clear` finishes, and ignored when stale.
- `/clear` no longer writes a handoff when no model is active.
- `session_start` restoration errors are caught and reported as warnings.
- Smoke test derives paths from its own location, uses a temp log file, polls on session ID instead of fixed sleeps, and exits non-zero on failure.

## [0.1.0] - 2026-10-01

### Added

- `/clear` command that starts a fresh session while preserving the current model and thinking level.
- Waits for the agent to become idle before clearing.
- Warnings when clearing is cancelled, the model is no longer available, or its auth is missing.
