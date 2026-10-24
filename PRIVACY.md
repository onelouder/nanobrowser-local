# Privacy Policy for Nanobrowser

## Introduction

[Nanobrowser](https://github.com/nanobrowser/nanobrowser) is an open-source AI web automation extension for Chrome and Edge. This Privacy Policy explains how it handles your data.

## Open source

Nanobrowser is licensed under the Apache License 2.0. All source code is public in our [GitHub repository](https://github.com/nanobrowser/nanobrowser), so you can check everything this policy says.

## What stays in your browser

- Nanobrowser runs in your browser, with an optional local helper for Downloads and Documents access. There is no Nanobrowser server, and no account.
- Your projects, conversations, checkpoints, execution history, retained evidence and files, saved workflows, custom instructions, site notes, site settings and other settings are stored locally in your browser.
- PDF text is extracted locally in a bundled worker. The original PDF and its extracted text stay in browser storage until their conversation or project copy is deleted. Scanned pages are not sent to an OCR service.
- Your logins and cookies never leave your browser through Nanobrowser.
- The values of password, payment-card and one-time-code fields are hidden from the AI model.

## What is sent to the Nanobrowser team

This local-inference fork disables analytics and the uninstall survey. It does not send usage statistics to the Nanobrowser team or PostHog.

## What is sent to the providers you choose

To work, Nanobrowser sends data directly from your browser to the AI providers you set up, and only to them:

- **Your model provider** (for example Anthropic, OpenAI, Google, OpenRouter, or a local server such as Ollama): your messages, local file names and content read by the agent, text and image attachments, extracted PDF text, custom instructions, project objectives and instructions, explicitly selected project evidence, applicable site notes and selected workflow text, the content of the tabs the agent works in, and, for models that can see images, screenshots of those tabs.
- **Sites you upload to** receive the original attached file when you ask the agent to upload it, subject to your permission settings. PDF extraction does not upload the original document to your model provider.
- **Your voice model provider** (OpenAI or Google), only if you turn on voice input: the audio of each recording. Recordings are not kept.

How these providers handle your data is governed by their own privacy policies. If you use a local model server, requests go to that server, including when it runs on another computer on your network.

## Direct local file access

- After you install the helper and grant native messaging permission, every chat can list and read files in your Downloads and Documents folders. No project or attachment selection is needed.
- The helper uses local standard input/output with Chrome or Edge. It opens no network listener and accepts connections only from the extension IDs registered during installation.
- Reads enter the conversation and are sent to the model provider you selected. File content is treated as untrusted data. Ask mode confirms writes; Auto mode allows direct writes. Existing files require an explicit overwrite request.
- Files written by the helper are ordinary files on your computer. Deleting chats, clearing browser data, or uninstalling the extension does not delete those files or uninstall the helper.
- Access is restricted to Downloads and Documents; symbolic links and hard-linked files are not followed. Revoking the extension's native messaging permission disables helper access.

## Project transfers

- Project bundles are downloaded only when you choose Export. They contain project notes, conversation history, retained evidence, file bytes, and recovery metadata. There is no automatic synchronization service.
- Bundles exclude connection profiles, API keys, live tab bindings, and pending approvals. Import creates a separate project and requires you to choose a model connection on that computer before resuming.
- Opening or importing a project does not start browser automation. Resuming reopens selected saved pages and observes their current state; browser cookies and unsaved forms are not transferred.
- Project-owned evidence and generated files remain when an individual session is deleted. Remove those files in the workspace or use Delete everything to remove all project data.

## API keys

- You provide your own API keys.
- Keys are stored locally in your browser, and are sent only to their own provider.
- Keys are never included in exports and never written to logs.

## Updating from an earlier version

When Nanobrowser updates from its earlier version, it moves your providers and API keys, your default model, your saved prompts and your blocked sites into the new version, in your browser, and deletes the rest of the earlier version's data. Your earlier conversations are kept in your browser until you export or delete them in Settings → Data; nothing is sent anywhere.

## Your control

- Delete a conversation or individual project files at any time, or delete all your data in Settings → Data.
- Uninstall the extension to remove all its local data.

## Changes to this policy

We may update this policy. Changes are published in the GitHub repository.

## Contact

Questions or concerns? Contact us at cws@felight.xyz.

Last updated: October 23, 2026
