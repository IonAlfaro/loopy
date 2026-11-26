# Changelog

All notable changes to **Loopy** are documented in this file.

## [0.1.0] — Initial Public Release

### Added
- **Agent Mode**: Autonomous coding, research, and file/browser workspace with 4-tier safety permissions (`Read-only`, `Ask`, `Auto` with AI safety reviewer, `Turbo`), live context counter, Thinking/Reasoning effort selector, isolated & parallel subagents, live todo checklist, background processes, task scheduler, interactive questions, persistent Markdown/HTML artifacts, global MCP servers, and image generation.
- **Interactive Embedded Browser**: Chrome-style multi-tab interactive browser panel powered by pure-Rust Chromium CDP with direct click/type/scroll forwarding, editable omnibox, and persistent profile shared live with the AI Agent.
- **Visual Cyclic Harness Studio**: Drag-and-drop React Flow canvas with `Agent`, `Shell / Test`, `For Each / Iterator`, `JSON Validator`, `LLM Judge`, `Loop Guard`, `Human Gate`, `Git Checkpoint`, `Context Compactor`, `Knowledge / RAG`, `Memory / State`, `HTTP Request`, `Notify`, `Trigger` (Webhook / Cron / Telegram), `MCP Server`, `Skills`, `Parallel Fan-Out`, `Subgraph`, and `Custom Nodes` — plus global run budgets, per-node latency badges, 1-click resource wiring, and *Run from here* resume.
- **AI Architect**: Built-in graph designer with read-only workspace inspection tools.
- **Local & Cloud Inference**: Embedded `llama.cpp` GPU auto-installer (CUDA / Vulkan / Metal / CPU), dynamic Hugging Face GGUF browser (Trending, Most Downloaded, Most Liked, Most Recent), LM Studio & Ollama dedicated local API providers (with selectable OpenAI/Anthropic compatibility and optional server secret), plus OpenAI, Anthropic, Google Gemini, GitHub Models, OpenRouter, and custom endpoints.
- **Headless CLI & Self-Hosted Web Server (`loopy-cli`)**: Run harnesses from terminal/CI/CD (`loopy-cli run --jsonl`) or host the full Loopy Web Panel with Bearer token authentication and SSE streaming (`loopy-cli serve`).
- **Desktop & Distribution**: Branded Windows NSIS installer, English (default) & Spanish i18n, GitHub Releases auto-updater, and SignPath Foundation open-source code signing pipeline.
