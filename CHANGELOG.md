# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Public plugin API for guideline PDF imports (`api.importGuidelinePdf`) so other plugins can create Zotero guideline items, upload imported PDF attachments, apply sync tags, and receive Zotero item/attachment keys plus the synced literature-note path.
- Shared Zotero item creation and imported-file upload helpers in the Zotero API client for API-driven workflows.
- Public API helpers for triggering sync and finding literature notes by Zotero key.
- Guideline PDF import requests can now include an optional citekey, stored on the Zotero parent item as `Citation Key` in Extra for downstream note filename/rendering support.

### Fixed

- Stale tracked-note mappings are now cleared when the remembered note file is missing and Zotero no longer returns the item as sync-tagged, avoiding repeated `Missing tracked note ... will re-sync it` console messages.

## [1.0.0] - 2026-02-16

### Added

- Automatic literature note creation from Zotero items tagged with configurable tag
- Two-way tag synchronization between Zotero and Obsidian frontmatter
- Incremental sync using Zotero library version tracking (minimizes API calls)
- Color-grouped annotation rendering (6 default colors: yellow, gray, green, red, blue, orange)
- Image annotation support via Zotero Web API with local cache fallback
- Zotero deep links embedded in literature notes (`zotero://select`, `zotero://open-pdf`)
- Customizable file naming templates (`{{citekey}}`, `{{title}}`, `{{author}}`, `{{year}}`, `{{key}}`)
- Template customization via vault-based markdown template with 40+ placeholders
- Auto-sync at configurable intervals (0-120 min, default 30)
- Preservation of user-written comments in `## Comments` section across re-syncs
- Support for both personal and group Zotero libraries
- Commands: sync-now, full-sync, sync-current-note, register-existing-notes, open-settings
- Status bar with sync progress and last-sync timestamp
- Settings panel with test connection button
- Citekey extraction: Zotero 7 native field, Better BibTeX extra, or fallback
- Rate limiting with Backoff header and 429 retry handling
- 6-section note structure: Comments, Article Info, Abstract, Literature Quote, Zotero Notes, Reading Notes
- Reading time estimation (220 wpm x page count)

### Fixed

- `fetchItemChildren()` and `fetchAnnotations()` pagination: now uses `limit=100` instead of API default of 25 (previously missed annotations on PDFs with >25 highlights)
