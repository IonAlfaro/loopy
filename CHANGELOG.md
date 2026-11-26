# Changelog

All notable changes to **Loors** are documented in this file.

## [0.1.3] — Harness Auto-Save, Full Context Recovery & Silent Windows Updater

### Added
- **Harness Save (`Ctrl+S`), Auto-Save & Persistent Tabs**: Added a topbar Save button with dirty indicator, `Ctrl+S` shortcut, configurable automatic auto-save toggle in **Settings → General & Language** (saves after 1.5s of inactivity and before closing tabs), and automatic persistence/restoration of open Harness tabs across restarts.

### Fixed
- **Full `llama-server` Context Window Preserved**: Removed default `--parallel 2` slot splitting so local GGUF models use 100% of the configured `--ctx-size` while `llama-server` queues concurrent Agent + Harness requests cleanly.
- **100% Silent Windows Auto-Updater (`/S`)**: Windows NSIS/MSI updates now run completely silently in the background with zero installer wizard UI and automatically relaunch Loors once updated.
- **Auto-Retry on Truncated Local Tool Calls**: Automatically retries a step with bumped `repeat_penalty` and `temperature` when `llama-server` fails to parse tool-call JSON due to a local model repetition loop.

## [0.1.2] — Multi-Harness Tabs, Concurrent Execution & Autonomous Product Team

### Added
- **Multi-Harness Tabs & Concurrent Execution**: Open and run multiple harnesses simultaneously in isolated tabs (`[ ● tab × ] [ + ]`) while chatting in **Agent Mode** at the same time; backed by a per-tab `EngineManager` run map and `--parallel 2` concurrent slots in `llama.cpp`.
- **Autonomous Product Team Template**: Added an end-to-end unattended harness template (`PM & Architect → JSON Backlog Validator → For Each Task → Senior Engineer + Build & Test + Tech Lead Judge → QA & Delivery Report`).
- **Refreshed Loors Documentation Screenshots**: Updated README screenshots (`agent-mode`, `harness-studio`, `settings-apis`) with Loors branding and the polished UI.

### Fixed & Improved
- **Passive Windows Updater (`/P`)**: Windows NSIS/MSI updates now apply directly with a clean progress bar instead of reopening the full step-by-step installer wizard.
- **Collapsible Artifact Card**: Polished the Agent Mode artifact viewer to start collapsed by default with proper Obsidian/Violet styling, chevron toggle, and working Copy confirmation feedback.
- **Security**: Upgraded the Rust `zip` crate from `v2.6.1` to `v9.8.2`, resolving 3 Dependabot advisories (1 Critical, 1 High, 1 Moderate).
- **Responsive Harness Canvas**: Protected center canvas width with `minmax(320px, 1fr)` on narrow viewports.

## [0.1.1] — Loors Rebrand, Live Screencast Browser & UI Polish

### Added
- **Rebrand to Loors**: Renamed application, CLI (`loors-cli`), Rust library (`loors_lib`), NSIS installer banners, documentation, and repository (`IonAlfaro/loors`) with full backward compatibility for legacy `.loopy.json` (`loopyNode`) workflow files.
- **Multiplexed CDP Screencast (`<canvas>`)**: Upgraded the embedded browser to a single multiplexed CDP actor streaming live `Page.startScreencast` frames directly onto `<canvas>` for low-latency scrolling, typing, and clicking.
- **Per-Conversation Browser Tabs & Agent Lock**: Isolated browser tabs per chat session, added a clean blank New Tab start view, fixed full-area expand/restore, and added a non-intrusive viewport lock while the AI agent is actively browsing.
- **Conversation Sidebar Actions**: Added three-dots (`···`) menu to pin/unpin, inline-rename, and delete conversations, plus automatic chat title generation from the first prompt (EN & ES).
- **First-Run Onboarding Modal**: Moved the AI runtime/provider setup wizard out of the empty chat screen into a clean, dismissible first-run modal.

### Fixed
- **Console Bar & Auto-Scroll**: Redesigned the Harness Studio console bar with flat underline tabs and a single unified status indicator; fixed auto-scroll disabling itself while logs stream.
- **Browser CDP Reliability**: Added early browser exit detection with automatic isolated profile fallback on locked profiles, exact `object-fit: contain` click/wheel coordinate mapping, and `human_action_required` pause detection for CAPTCHAs/logins.
- **Localization**: Localized model loading/unloading progress pill and `llama.cpp` status messages in EN & ES.

## [0.1.0] — Initial Public Release

### Added
- **Agent Mode**: Autonomous coding, research, and file/browser workspace with 4-tier safety permissions (`Read-only`, `Ask`, `Auto` with AI safety reviewer, `Turbo`), live context counter, Thinking/Reasoning effort selector, isolated & parallel subagents, live todo checklist, background processes, task scheduler, interactive questions, persistent Markdown/HTML artifacts, global MCP servers, and image generation.
- **Interactive Embedded Browser**: Chrome-style multi-tab interactive browser panel powered by pure-Rust Chromium CDP with direct click/type/scroll forwarding, editable omnibox, and persistent profile shared live with the AI Agent.
- **Visual Cyclic Harness Studio**: Drag-and-drop React Flow canvas with `Agent`, `Shell / Test`, `For Each / Iterator`, `JSON Validator`, `LLM Judge`, `Loop Guard`, `Human Gate`, `Git Checkpoint`, `Context Compactor`, `Knowledge / RAG`, `Memory / State`, `HTTP Request`, `Notify`, `Trigger` (Webhook / Cron / Telegram), `MCP Server`, `Skills`, `Parallel Fan-Out`, `Subgraph`, and `Custom Nodes` — plus global run budgets, per-node latency badges, 1-click resource wiring, and *Run from here* resume.
- **AI Architect**: Built-in graph designer with read-only workspace inspection tools.
- **Local & Cloud Inference**: Embedded `llama.cpp` GPU auto-installer (CUDA / Vulkan / Metal / CPU), dynamic Hugging Face GGUF browser (Trending, Most Downloaded, Most Liked, Most Recent), LM Studio & Ollama dedicated local API providers (with selectable OpenAI/Anthropic compatibility and optional server secret), plus OpenAI, Anthropic, Google Gemini, GitHub Models, OpenRouter, and custom endpoints.
- **Headless CLI & Self-Hosted Web Server (`loors-cli`)**: Run harnesses from terminal/CI/CD (`loors-cli run --jsonl`) or host the full Loors Web Panel with Bearer token authentication and SSE streaming (`loors-cli serve`).
- **Desktop & Distribution**: Branded Windows NSIS installer, English (default) & Spanish i18n, GitHub Releases auto-updater, and SignPath Foundation open-source code signing pipeline.
