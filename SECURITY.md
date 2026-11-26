# Security Policy

## Reporting a Vulnerability

Loopy executes local shell commands, edits workspace files, and connects to external AI APIs when authorized by the user. We take security seriously.

If you discover a security vulnerability (for example, a permission bypass in `Read-only` or `Auto` safety review mode, path traversal, or credential leakage):

1. **Do not** open a public GitHub issue with exploit details.
2. Report it privately using GitHub's **Security Advisories** ("Report a vulnerability" under the **Security** tab of this repository).
3. Include a clear description, affected version, and minimal reproduction steps.

We will acknowledge your report promptly and work on a fix before public disclosure.

## Security Model Notes
- **API Keys**: Stored locally in your OS user data directory (`providers.json`) and never transmitted anywhere except directly to the configured provider endpoint. Environment variable references (`${OPENAI_API_KEY}`, `${ANTHROPIC_API_KEY}`, etc.) are supported and recommended.
- **Tool Permissions**: Agent Mode supports four explicit permission tiers (`Read-only`, `Ask`, `Auto` with AI safety review, and `Turbo`).
- **Local-First**: When using embedded `llama.cpp`, all prompts, files, and inference stay 100% on your machine.

## Code Signing Policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

### Roles & Release Integrity
- **Authors / Committers**: Public contributors via pull requests and repository maintainers.
- **Reviewers & Approvers**: Repository maintainers who review changes, tag releases (`v*`), and approve signing requests in SignPath.
- **Build & Signing Pipeline**: Official Windows installers (`.exe` / `.msi`) are built exclusively on GitHub-hosted runners from tagged commits via `.github/workflows/release.yml` and submitted directly as GitHub Actions artifacts to SignPath.

### Privacy Policy
- Loopy does **not** collect telemetry, analytics, crash reports, or personal data.
- All local models, workspaces, session logs, and credentials stay on the user's machine.
- Outbound network requests only occur when explicitly initiated by the user (e.g., downloading `llama.cpp` or GGUF models from Hugging Face, checking GitHub Releases for updates, calling a user-configured external AI API, or running web/browser tools).
