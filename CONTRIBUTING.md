# Contributing to Loopy

Thank you for your interest in contributing to **Loopy**! We welcome bug reports, feature suggestions, documentation improvements, custom node templates, and pull requests.

## Development Setup

### Prerequisites
- **Node.js** 20+
- **Rust** stable toolchain (`rustup`, `cargo`)
- Platform-specific Tauri v2 dependencies (see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/))

### Run in Development Mode
```bash
npm install
npm run tauri dev
```

### Run Tests & Checks
```bash
# Frontend TypeScript check + production build
npm run build

# Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml

# Rust linter
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Pull Request Guidelines
1. Keep PRs focused on a single feature, fix, or refactor.
2. Add unit tests for new Rust engine, inference, or tool logic.
3. Ensure `npm run build` and `cargo test` pass with zero warnings.
4. Keep UI strings localized in both English (`en`) and Spanish (`es`) in `src/i18n.ts` (English is the default).
5. Avoid adding unnecessary external dependencies when standard library or existing crates/APIs suffice.

## Reporting Issues
Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) or [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) templates and include your OS, GPU/backend (or API provider), and reproduction steps.
