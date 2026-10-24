# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-24

### Added

- A `local` provider for magpie that starts `llama-server` when a request needs it and stops it after `idleMinutes` of idleness.
- Models named `local/<id>`, the id defaulting to the model file name without its extension.
- A fixed port, or an automatically chosen one that is bind-tested before it is used.
- One shared start promise for concurrent requests, so a cold start launches a single process.
- A `warmup` option that loads the model when the plugin host starts.
- Failures answered with 503, carrying the command line and the tail of llama-server's stderr.
- The plugin host stops its llama-server when it exits, and a pipe-held watchdog stops it even when the host is killed with SIGKILL.

[Unreleased]: https://github.com/zerodegress/magpie-not-enough-llama/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zerodegress/magpie-not-enough-llama/releases/tag/v0.1.0
