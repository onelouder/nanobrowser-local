# Nanobrowser Local

A local-first fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser) for browser automation, website investigation, and cleanroom rebuild workflows. Work in the browser side panel, organize investigations in projects, retain evidence, and resume saved sessions.

This repository is **[onelouder/nanobrowser-local](https://github.com/onelouder/nanobrowser-local)**. The upstream Chrome Web Store listing installs upstream Nanobrowser, not this fork. Build and load this fork using the instructions below.

## What this fork adds

- **Editable inference limits:** context and output budgets per model, with a 150,000-token context default for the built-in ether-10 agent, max, and code profiles. Other profiles retain their own limits.
- **Configurable concurrency:** four concurrent model requests per provider by default. The built-in ether-10 LAN and Tailscale connections share a queue because they reach the same backend.
- **Run controls:** configurable turn, consecutive-error, and no-progress limits; pause and save; explicit resume review.
- **Project workspace:** objectives, target sites, instructions, notes, existing/new sessions, files, evidence, checkpoints, and run history.
- **Portable projects:** export/import project bundles with conversation history and retained files. Imported sessions require local model selection before running.
- **PDF text extraction:** bundled PDF.js extracts text locally before the selected model receives it. CSS and common source/configuration files can also be attached as text.
- **Reusable guidance:** custom instructions, site notes, and shortcuts with editable keyboard bindings.
- **Local inference presets:** ether-10 and ether-9 OpenAI-compatible connections, alongside Ollama, LM Studio, and cloud providers.
- **Telemetry disabled:** this fork disables analytics and the uninstall survey; see [PRIVACY.md](PRIVACY.md).

The extension retains the upstream agent's browser tools, permission modes, vision support, voice input, and English, Simplified Chinese, and Traditional Chinese interfaces.

## Install on macOS, Windows, or Linux

Chrome and Edge are supported. Firefox and Safari are not supported; other Chromium browsers are not tested. The extension uses browser APIs and does not need a native companion service.

### Build from source

Install **Node.js 24 LTS** (24.11 or later) and **pnpm 10.34.7**, pinned in `package.json`. Use the Node build matching your machine's architecture, including ARM64 on Apple Silicon and DGX Spark.

```sh
git clone https://github.com/onelouder/nanobrowser-local.git
cd nanobrowser-local
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

If your Node installation does not include Corepack, install the pinned pnpm version using [pnpm's installation instructions](https://pnpm.io/installation), then run the commands with `pnpm` instead of `corepack pnpm`.

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository's `dist` directory.
4. Pin Nanobrowser in the toolbar and click its icon to open the side panel.
5. Open **Settings → Providers** and verify your model connection.

`corepack pnpm zip` builds `dist-zip/nanobrowser-0.3.0.zip`. To install that package, extract it into a permanent directory and load the extracted folder containing `manifest.json` using **Load unpacked**. The ZIP is an unpacked-extension distribution artifact, not an automatic installer or updater.

### Update an existing installation

Export important projects first. Pull the latest source, run `corepack pnpm install --frozen-lockfile` and `corepack pnpm build`, then click **Reload** on the existing extension card. Keep the same installation directory and browser profile; removing the extension can delete its local data.

CI runs formatting, lint, type checking, unit tests, and builds on Ubuntu, macOS, and Windows. Native browser checks have also been run locally on Linux ARM64; CI does not run those browser checks.

## Connect a local model

### ether-10 proxy

The fork seeds separate **ether-10 GLM-5.3 (LAN)** and **ether-10 GLM-5.3 (Tailscale)** provider cards. These contain environment-specific addresses, not universally reachable services; check and edit their **Base URL** for your installation. The shipped default model is the proxy alias `dsv4-agent`; available aliases depend on your proxy configuration.

1. Open **Settings → Providers** and select the ether-10 connection reachable from this computer.
2. Confirm its OpenAI-compatible base URL, including `/v1`, and configure a key if your proxy requires one. The shipped presets assume no key.
3. Fetch the model list and run **Test models**. Listing models alone does not prove that generation or tool calling works; adding a local model reads metadata without automatically running the full inference test.
4. Select a model that supports tool calling and choose it in the side panel.
5. Review its context/output limits and provider concurrency before starting a large task.

The LAN and Tailscale cards are alternative connections to the same backend, not automatic failover routes. The concurrency limit applies within this extension instance; multiple browsers or computers require server-side admission control for a shared global limit.

### Other servers

Use the **Ollama**, **LM Studio**, or **OpenAI-compatible** provider type for your server. `localhost` means the computer running the browser, so a model on another machine needs that machine's reachable address. The provider card offers origin/CORS setup guidance when a local server refuses the extension.

Cloud providers remain optional. Voice input uses the configured OpenAI or Gemini provider; it is not routed through ether-10 automatically.

### Tune budgets

- **Settings → Providers:** edit each model's context window and output budget, and the provider's concurrency limit.
- **Settings → General:** edit the turn, consecutive-error, and no-progress limits.
- Keep the context window within the server's loaded capacity. Setting a larger number in the extension does not enlarge the model or proxy's actual context.
- Context includes both prompt and output. Automatic compaction keeps long sessions within the budget and retains the user's messages.
- Detected local-server limits can lower the effective context. The provider UI displays effective limits so you can check what will actually be used.

## Work in a project

Click **Projects** in the side panel to open the full-page workspace.

1. Create a project with an objective, target sites, and instructions. Project objectives and instructions are included in its sessions; notes remain in the workspace unless you share them.
2. Create a session with a starting task, or move an existing chat from **Unassigned sessions** into the project. Creating a session does not start the agent; the first target site becomes its saved starting page.
3. Use **Open chat** to read and continue that session directly in the workspace. The **Chat** tab and browser side panel show the same conversation; **Open website and side-panel chat** switches to its website. Use **Review and resume** to inspect a saved run before continuing it.
4. Use **Save recent evidence** to retain up to the latest 20 successful page captures from the active conversation branch. Evidence records its source URL and capture time when available.
5. Search, preview, or download files from **Evidence** and **Files**. Select files, choose the session, and click **Add selected to session** to return to that chat with the files attached. They remain available when you send the next prompt; storing a file alone does not send it to the model.

When you open **Projects** from an existing chat, its conversation is selected. To organize an unassigned chat, select or create a project and click **Move this conversation into this project**; the open side panel updates immediately. If a session’s website tab closes or moves to another conversation, use **Reconnect website** in the project chat before sending another message.

For website investigation, separate sessions by task—for example navigation mapping, form behavior, responsive layout, and content structure—while keeping their evidence in one project. Shortcuts can hold recurring investigation prompts.

### Pause and resume

**Pause and save** stops the active run and persists a checkpoint. **Review and resume** shows the saved model/configuration and missing or blocked pages before another execution attempt starts.

Browser tab IDs are not portable identities. Recovery uses saved URLs, current permissions, and a fresh page observation. Interrupted writes with uncertain outcomes remain marked as uncertain; they are not automatically replayed. Browser login state, cookies, unsaved form values, and the exact previous DOM are not restored from a project bundle.

### Move work to another computer

Use **Export project**, transfer the JSON bundle, and choose **Import project** in the destination workspace. Import creates a new project with new record IDs, preserves retained files and history, and resets sessions to Ask mode. Choose a locally configured model before resuming.

Provider connection profiles, stored API keys, live tab bindings, and pending approvals are excluded. Conversation text and collected evidence are included and may contain private information. There is no automatic cloud synchronization.

## Files and current limits

| Item                   | Current behavior or limit                                                     |
| ---------------------- | ----------------------------------------------------------------------------- |
| Project files          | Any file type can be retained and downloaded; 25 MB per file                  |
| Project storage        | 250 MB and 1,000 files per project                                            |
| Session attachments    | 100 MB total; supported images, PDFs, and text/source files                   |
| Project export/import  | 50 MB JSON bundle, including encoded file data and history                    |
| PDF extraction         | Up to 200 pages, 1,000,000 characters, and 30 seconds; truncation is reported |
| Saved browser manifest | Up to 50 HTTP(S) tabs per session                                             |
| Run history display    | Latest 100 attempts per session                                               |

PDF extraction reads embedded text; it does not perform OCR on scanned pages. Text extraction from password-protected PDFs and Office document parsing are not supported; their original bytes can still be retained as project files. Unsupported binary formats can be retained as project files but cannot be sent as readable attachments.

The agent's **`save_file` tool still generates CSV, Markdown, JSON, TXT, and HTML only**. Storing and downloading an uploaded CSS or arbitrary binary file is supported; generating arbitrary file types through `save_file` remains future work. Generated downloads from project sessions are also retained in the project when its storage budget permits.

## Permissions and privacy

| Action                                                 | Ask mode (default)    | Auto mode             |
| ------------------------------------------------------ | --------------------- | --------------------- |
| Read pages, follow links, scroll, move between tabs    | Goes ahead            | Goes ahead            |
| Detected submit, send, delete, or upload               | Asks first            | Goes ahead            |
| Detected payment, password/code entry, or access grant | Hands the step to you | Hands the step to you |

Set per-site **Allow**, **Ask**, or **Block** rules in **Settings → Permissions**. Detection is best effort; the model cannot change these rules. Page content is treated as data, and **Stop** returns control to you.

Projects, conversations, and settings are stored in the browser profile. Content used for inference goes to the model provider you select, which may run on this machine, another local machine, or a cloud service. See [PRIVACY.md](PRIVACY.md) for retention and transfer details.

## Development and checks

```sh
corepack pnpm dev
corepack pnpm exec prettier --check .
corepack pnpm lint
corepack pnpm type-check
corepack pnpm test
corepack pnpm build
corepack pnpm zip
```

Native browser checks use the extension's own `chrome.debugger` integration, without external CDP or a real model endpoint:

```sh
corepack pnpm install-chrome
corepack pnpm autorun workspace-chat,workspace,restart-restore,panel-attach,inference-controls,permission-warnings --timeout 180
```

If Chrome for Testing is unavailable for your architecture, set `CHROME_PATH` to a compatible installed Chrome/Chromium executable before running `autorun`. Example environment syntax:

```sh
# macOS/Linux
CHROME_PATH="/path/to/chrome" corepack pnpm autorun workspace
```

```powershell
# Windows PowerShell
$env:CHROME_PATH = 'C:\path\to\chrome.exe'
corepack pnpm autorun workspace
```

The harness uses an isolated test profile and mock keychain. Reports and screenshots are written to `fixtures/.results/`, which is ignored by Git. Browser checks and real-model evaluations are separate from the cross-platform CI suite.

The deterministic browser control layer observes and acts through `chrome.debugger`; Puppeteer manages frames. The agent sits above that layer. [AGENTS.md](AGENTS.md) describes architecture and contribution constraints; see also [CONTRIBUTING.md](CONTRIBUTING.md).

## Planned improvements

These are recommendations, not implemented features: a guided ether-10 connection wizard, importable connection profiles, a connection/queue diagnostics dashboard, investigation templates, and managed distribution/update flows.

## Upstream and license

This fork builds on [Nanobrowser](https://github.com/nanobrowser/nanobrowser), Puppeteer, the Vercel AI SDK, WXT, and PDF.js. Upstream community links and support information are available in the upstream repository. For fork-specific issues, use [this repository's issue tracker](https://github.com/onelouder/nanobrowser-local/issues).

Licensed under Apache-2.0; see [LICENSE](LICENSE). For vulnerability reporting, see [SECURITY.md](SECURITY.md).
