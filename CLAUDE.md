# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Zotero Connector

Zotero Connector is an Obsidian plugin that automatically creates and updates literature notes from Zotero items tagged with a configurable tag (default: `obsidian`). It supports two-way tag synchronization, incremental sync via version tracking, color-grouped annotation rendering, image annotations from PDFs, and customizable templates.

## Build Commands

```bash
npm run dev    # Watch mode with inline source maps
npm run build  # Production bundle (no type-check step)
```

Output: `main.js` (CommonJS, ES6 target). No test suites or linters.

## Obsidian CLI

```bash
cmd //c "obsidian plugin:reload id=zotero-connector" 2>&1
cmd //c "obsidian dev:errors" 2>&1
```

## Obsidian Paths

Paths differ by machine:

| | Machine 1 (EckRJ) | Machine 2 (ruben) |
|---|---|---|
| **Vault** | `C:\Users\EckRJ\Documents\Ideaverse` | `C:\Users\ruben\Ideaverse` |
| **Plugin deploy** | `...\Ideaverse\.obsidian\plugins\zotero-connector\` | same relative |
| **Literature notes** | `...\Ideaverse\References\Literature notes\` | same relative |

## Architecture

### Entry Point (`src/main.ts`, 383 lines)

`ZoteroConnectorPlugin` orchestrates sync operations, registers commands (sync-now, full-sync, sync-current-note, register-existing-notes, open-settings), manages auto-sync timer, and provides status bar updates with sync progress/timestamp. API key stored in Obsidian's `secretStorage`.

### Zotero API Layer (`src/zotero/`)

- **api-client.ts** — Wraps Zotero Web API v3 with rate limiting (Backoff header, 429 retries), pagination (100 items/page), collection caching, and user/group library support. Methods: `testConnection()`, `fetchItemsByTag()`, `fetchItemChildren()`, `fetchAnnotations()`, `fetchBibliography()`, `fetchAnnotationImage()`, `patchItemTags()`.
- **types.ts** — Zotero data models: `ZoteroItem`, `ZoteroItemData`, `ZoteroCreator`, `ZoteroTag`, `SyncItemData`.

### Sync Engine (`src/sync/`)

- **sync-manager.ts** (596 lines) — Core sync logic: fetch tagged items, diff against versions, render and write to vault. Two-way tag merge (Zotero tags + frontmatter tags with baseline tracking). Handles file renames on citekey changes. Preserves user comments in `## Comments` section (wrapped in `%% begin/end Comments %%` markers). Image annotation processing with Web API + local cache fallback.
- **version-tracker.ts** — Tracks library version and per-item versions for incremental sync.

### Note Renderer (`src/renderer/note-renderer.ts`, 773 lines)

Converts `SyncItemData` to markdown with YAML frontmatter and 6 content sections:
1. **Comments** — preserved across syncs
2. **Article Info** — callout with Zotero/DOI/PDF links, bibliography, collections, page count, reading time (220 wpm)
3. **Abstract** — callout with bolded structural keywords
4. **Literature Quote** — query block placeholder
5. **Zotero Notes** — long notes in nested callouts
6. **Reading Notes** — annotations grouped by color, sorted by position

Supports 40+ template placeholders. Handles 4 annotation types: image, comment-only, comment+text, text-only.

### Settings (`src/settings.ts`, 353 lines)

Settings panel with auth (API key, user ID, library type), sync configuration (tag, auto-interval, output folder, filename template), template file path, color map (annotation color to section heading), image annotation options, and advanced toggles (preserve user content, mark orphaned).

### Utilities

- **filename.ts** — Template-based filename generation with citekey extraction (Zotero 7 native field, Better BibTeX extra, fallback). Sanitization and collision handling.

## Key Design Decisions

- API key in `secretStorage`, not in plugin settings JSON
- Incremental sync: only re-syncs items whose version changed since last sync
- Two-way tag sync: normalizes hyphens/spaces, tracks baseline, detects user vs Zotero deletions
- Version conflict handling (409): logs warning, retries next sync
- Collection cache: persistent during sync cycle, cleared on reset
- Reading time: estimated at 220 words/min x page count

## Conventions

- **HTTP**: Use Obsidian's `requestUrl()`, not `fetch()`
- **Secrets**: API keys via `app.secretStorage`
- **Frontmatter**: `zotero-key`, `zotero-uri`, `tags`, `citekey`
- **Logging**: Console output prefixed with `[Zotero Connector]`
