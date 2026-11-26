# Changelog

All notable changes to **Loors** are documented in this file.

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
