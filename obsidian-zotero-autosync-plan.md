# Obsidian Zotero Auto-Sync Plugin — Development Plan

## Overview

An Obsidian plugin that automatically creates and updates literature notes from Zotero items tagged with a configurable tag (default: `obsidian`). Uses the Zotero Web API v3 to fetch items and their PDF annotations, then renders them into Obsidian markdown notes using a customizable color-grouped template.

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Zotero Web  │────▶│  ZoteroApiClient │────▶│  NoteRenderer    │
│  API v3      │     │  (fetch + cache)  │     │  (template logic)│
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                        │
                     ┌──────────────────┐              │
                     │  SyncManager     │◀─────────────┘
                     │  (orchestrator)  │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  Obsidian Vault  │
                     │  (create/update) │
                     └──────────────────┘
```

### Core modules

1. **`ZoteroApiClient`** — HTTP layer for Zotero Web API v3
2. **`SyncManager`** — Orchestration: scheduling, diffing, conflict handling
3. **`NoteRenderer`** — Converts Zotero item + annotations → markdown string
4. **`main.ts`** — Plugin entry: settings, commands, ribbon icon, intervals

---

## Zotero Web API v3 — Key Endpoints Used

All requests go to `https://api.zotero.org` with header `Zotero-API-Version: 3`.

### Authentication
- Header: `Zotero-API-Key: <key>`
- User creates key at https://www.zotero.org/settings/keys/new

### Endpoints

| Purpose | Endpoint | Notes |
|---|---|---|
| Get items by tag | `GET /users/<userID>/items?tag=obsidian&limit=100` | Returns top-level items matching tag. Paginate with `start` param. |
| Get single item | `GET /users/<userID>/items/<itemKey>` | Full metadata for one item |
| Get children (attachments) | `GET /users/<userID>/items/<itemKey>/children` | Returns attachments (PDFs) and notes |
| Get annotations | `GET /users/<userID>/items/<attachmentKey>/children` | Annotations are children of PDF attachments, `itemType: "annotation"` |
| Check for updates | Use `If-Modified-Since-Version: <ver>` header | Returns `304` if nothing changed; or use `?since=<version>` |
| Get library version | Response header `Last-Modified-Version` | Track this to know when to re-fetch |
| Groups support | `GET /groups/<groupID>/items?tag=obsidian` | Same pattern, different prefix |

### Annotation JSON structure (from API)

```json
{
  "key": "ABC12345",
  "itemType": "annotation",
  "parentItem": "PDF_KEY",
  "annotationType": "highlight",
  "annotationText": "The highlighted text from the PDF",
  "annotationComment": "User's comment on the highlight",
  "annotationColor": "#ffd400",
  "annotationPageLabel": "12",
  "annotationSortIndex": "00011|000412|00574",
  "annotationPosition": "{\"pageIndex\":11,\"rects\":[[...]]}",
  "tags": [{ "tag": "important" }],
  "dateAdded": "2024-03-11T03:29:36Z",
  "dateModified": "2024-03-11T03:29:36Z"
}
```

### Rate limiting
- Respect `Backoff` header (pause for N seconds)
- Handle `429 Too Many Requests` with `Retry-After`
- Max 100 items per request; paginate using `start` + `limit`

---

## Data Flow (Sync Cycle)

```
1. Fetch all items with tag "obsidian" (paginated)
   GET /users/{id}/items?tag=obsidian&format=json&limit=100&start=0

2. For each item, check if we already have a note:
   - Compare item version (stored in plugin data) vs API version
   - If new or changed → proceed to step 3
   - If unchanged → skip

3. For changed/new items, fetch children:
   GET /users/{id}/items/{itemKey}/children
   → filter for itemType === "attachment" (PDF attachments)
   → also collect itemType === "note" (Zotero notes, for Section 2 of template)

4. For each PDF attachment, fetch its children (annotations):
   GET /users/{id}/items/{attachmentKey}/children
   → filter for itemType === "annotation"

5. Group annotations by annotationColor

6. Render markdown using template (see Template section)

7. Write/update the .md file in vault
   - If file exists → update content (preserve any user-added sections)
   - If file doesn't exist → create it

8. Store item version + last sync timestamp in plugin data
```

### Optimization: `since` parameter

After first full sync, subsequent syncs use:
```
GET /users/{id}/items?tag=obsidian&since=<lastLibraryVersion>
```
This returns only items modified since last sync, dramatically reducing API calls.

---

## Plugin Settings

```typescript
interface ZoteroAutoSyncSettings {
  // Auth
  apiKey: string;
  userId: string;
  libraryType: 'user' | 'group';
  groupId?: string;

  // Sync behavior
  syncTag: string;                    // default: "obsidian"
  autoSyncIntervalMinutes: number;    // default: 30, 0 = disabled
  outputFolder: string;               // default: "Zotero Literature Notes"
  fileNameTemplate: string;           // default: "{{citekey}}" or "{{title}}"

  // Template
  colorMap: ColorMapEntry[];          // customizable color → heading mapping
  longNoteCutoff: number;             // default: 20 — word count threshold for "long" Zotero notes

  // Advanced
  preserveUserContent: boolean;       // default: true — don't overwrite manual edits below a marker
  lastSyncVersion: number;            // internal — last library version synced
  itemVersions: Record<string, number>; // internal — per-item version tracking
}

interface ColorMapEntry {
  color: string;       // e.g. "#ffd400"
  colorName: string;   // e.g. "Yellow"
  heading: string;     // e.g. "🎯 Key takeaways"
  symbol: string;      // e.g. '<mark style="background: #ffd400">🟡</mark>'
}
```

### Default color map (matching your current template)

```typescript
const DEFAULT_COLOR_MAP: ColorMapEntry[] = [
  { color: "#ffd400", colorName: "Yellow",  heading: "🎯 Key takeaways",                symbol: '<mark style="background: #ffd400">🟡</mark>' },
  { color: "#aaaaaa", colorName: "Gray",    heading: "✅ Context and target population",  symbol: '<mark style="background: #aaaaaa">⚪</mark>' },
  { color: "#5fb236", colorName: "Green",   heading: "📌 General methods and results",   symbol: '<mark style="background: #5fb236">🟢</mark>' },
  { color: "#ff6666", colorName: "Red",     heading: "🚧 Limitations",                   symbol: '<mark style="background: #ff6666">🔴</mark>' },
  { color: "#2ea8e5", colorName: "Blue",    heading: "🩺 Diagnostiek",                   symbol: '<mark style="background: #2ea8e5">🔵</mark>' },
  { color: "#f19837", colorName: "Orange",  heading: "💊 Behandeling",                   symbol: '<mark style="background: #f19837">🟠</mark>' },
];
```

---

## Note Template (Markdown Output)

The rendered note faithfully reproduces the structure of the existing Nunjucks template. It has **seven sections** in order: YAML frontmatter, persisted comments, article information callout, abstract callout, literature quote callout, Zotero notes callout, and reading notes.

### Full rendered example

````markdown
---
note type: 
- "[[Research papers.base|Research papers]]"
citekey: smith2024example
title: Example Article Title
authors:
- "[[Smith, John]]"
- "[[Doe, Alice]]"
journal: The Lancet
url: https://doi.org/10.1234/example
published: 2024-03-15
zotero: 2024-04-01
zotero-uri: https://www.zotero.org/users/12345/items/ABCD1234
tags: 
- systematic-review
- cardiology
last-synced: 2025-06-15T14:32:00Z
zotero-key: ABCD1234
---

## Comments 


## Article information
> [!info]- Info 🔗 [**Zotero**](zotero://select/library/items/ABCD1234) | [**DOI**](https://doi.org/10.1234/example) | [**PDF-1**](file:///path/to/file.pdf)
>
>**Bibliography**:: Smith, J., & Doe, A. (2024). Example Article Title. *The Lancet*, 123(4), 56–78.
>
> **Collections**:: [[Cardiology]], [[Systematic Reviews]]
>
> **Authors**:: John Smith, Alice Doe
> 
> **Title**:: Example Article Title
> 
> **Journal**:: The Lancet
> 
> **Publication year**:: 2024
> 
> **First-page**:: 56
> 
> **Page-count**:: 22
> 
> **Reading-time**:: 0.6 hours

> [!abstract]-
> **Background** This study examines...
> **Results** We found that...
> **Conclusion** These findings suggest...

> [!literature_quote]- Citations
> 
> ```query
> content: "smith2024example" -file:smith2024example
> ```

> [!note]- Zotero notes (1)
> 
> Notes longer than 20 words.
>> [!example]- Note 1 | [Important methodological consideration](zotero://select/library/items/NOTE_KEY1)
>> This study uses a novel approach to meta-analysis
>> that accounts for heterogeneity across studies.
>> 
>> Tags: #methodology

## Reading notes

*Imported on [[2025-06-15]] at 14:32*

### 🎯 Key takeaways

###### This is a critical finding
- <mark style="background: #ffd400">🟡</mark>  Patients receiving early intervention showed 40% improvement [(p. 12)](zotero://open-pdf/library/items/ATTACH_KEY?page=12) #important

- <mark style="background: #ffd400">🟡</mark>  The effect persisted at 6-month follow-up [(p. 14)](zotero://open-pdf/library/items/ATTACH_KEY?page=14)

### ✅ Context and target population

###### Elderly population
- <mark style="background: #aaaaaa">⚪</mark>  Included patients aged 65 and older with chronic heart failure [(p. 3)](zotero://open-pdf/library/items/ATTACH_KEY?page=3)

### 📌 General methods and results

- <mark style="background: #5fb236">🟢</mark>  Randomized controlled trial with 500 participants [(p. 7)](zotero://open-pdf/library/items/ATTACH_KEY?page=7)

### 🚧 Limitations

###### Small sample size
- <mark style="background: #ff6666">🔴</mark>  The sample was limited to a single hospital [(p. 22)](zotero://open-pdf/library/items/ATTACH_KEY?page=22)

````

---

### Section 0: YAML Frontmatter

Mirrors lines 2–15 of the original Nunjucks template exactly.

```yaml
---
note type: 
- "[[{conditional based on itemType}]]"
citekey: {citekey}
title: {title, colons replaced with " -"}
authors:                                 # as wiki links
- "[[{LastName, FirstName}]]"            # or "[[{Name}]]" for single-name/institutional
journal: {publicationTitle, colons replaced with " -"}
url: https://doi.org/{DOI}              # only if DOI exists
published: {date formatted YYYY-MM-DD}
zotero: {dateAdded formatted YYYY-MM-DD}
zotero-uri: {web URI, e.g. https://www.zotero.org/users/{userId}/items/{itemKey}}
tags:                                    # only if tags exist
- {tag1, spaces replaced with hyphens}
- {tag2}
last-synced: {sync timestamp}            # added by this plugin
zotero-key: {itemKey}                    # added by this plugin
---
```

**`note type` wiki-link logic (single entry, no more "Literature note"):**

```
if itemType === "book":
    → "[[Books]]"
elif itemType === "journalArticle" OR itemType === "preprint":
    → "[[Research papers.base|Research papers]]"
elif itemType === "thesis" OR itemType === "bookSection":
    → "[[Book Sections]]"
else:
    → "[[{itemType split on camelCase, Title Cased}]]"
    e.g. "conferencePaper" → "[[Conference Paper]]"
         "webpage"         → "[[Webpage]]"
```

The camelCase splitting uses the regex `/([a-z])([A-Z])/g` with replacement `"$1 $2"`, then applies Title Case.

**`authors` as wiki links:**

Zotero creators come in two API formats. Render both as wiki links:

```
for each creator in item.data.creators:
    if creator.lastName AND creator.firstName:
        → "[[{lastName}, {firstName}]]"
    elif creator.name:
        → "[[{name}]]"            // institutional or single-name authors
```

This produces:
```yaml
authors:
- "[[Smith, John]]"
- "[[Doe, Alice]]"
- "[[World Health Organization]]"
```

Note: Zotero data can be inconsistent across entries (e.g., "J. Smith" vs "John Smith"). The plugin renders whatever Zotero provides. Users can manage duplicates in Obsidian using aliases.

**`zotero-uri`:** The web URL to the item: `https://www.zotero.org/users/{userId}/items/{itemKey}` (or `/groups/{groupId}/items/{itemKey}` for group libraries).

---

### Section 1: Persisted Comments

```markdown
## Comments 

{user's notes go here — preserved on every re-sync}
```

On **first create**: render `## Comments` with a blank line below.

On **update/re-sync**: this section must be **preserved in full** — the plugin never overwrites it. The sync logic identifies this section by finding `## Comments` and preserving everything between it and `## Article information`.

This replaces the old Meta Bind `BUTTON[update-litnote]` — the plugin handles sync automatically, so no manual button is needed.

---

### Section 2: Article Information Callout

A collapsible `[!info]` callout with metadata, links, and computed reading time. Mirrors lines 28–68 of the original template.

**Rendering logic:**

```
// Header line with links
output: '> [!info]- Info 🔗 [**Zotero**]({desktopURI})'
if DOI:
    append: ' | [**DOI**](https://doi.org/{DOI})'
for each PDF attachment:
    append: ' | [**PDF-{index}**](file:///{attachment.path with spaces→%20})'

output: '>  '

// Bibliography (from Zotero formatted citation — see note below)
if bibliography:
    output: '>**Bibliography**:: {bibliography, stripped of newlines and leading numbering}'

output: '>  '

// Collections as WIKI LINKS
output: '> **Collections**:: '
for each collection:
    append: '[[{collection.name}]]'
    if not last: append ', '

// Page range parsing (for first-page, page-count, reading-time)
readingSpeed = 220  // words per minute
wordsPerPage = 360
parse pages field:
    if matches regex /(\d+)-(\d+)/:
        firstPage = match[1]
        pageCount = match[2] - match[1]
    else:
        pageCount = pages (as number)
if no pages but numPages exists:
    pageCount = numPages

// Author/title/journal block (only if firstPage was determined)
if firstPage:
    output: '> **Authors**:: {for each creator: firstName lastName, comma-separated}'
    output: '> **Title**:: {title}'
    output: '> **Journal**:: {publicationTitle}'
    output: '> **Publication year**:: {date formatted YYYY}'
    output: '> **First-page**:: {firstPage}'

// Reading time block (only if pageCount > 0)
if pageCount > 0:
    readingTime = (pageCount * wordsPerPage / readingSpeed) / 60  // in hours
    output: '> **Page-count**:: {pageCount}'
    if readingTime < 1:
        output: '> **Reading-time**:: {round(readingTime * 60)} minutes'
    else:
        output: '> **Reading-time**:: {round(readingTime, 3)} hours'
```

**Note on bibliography:** The Zotero Web API can return formatted bibliography via `include=bib` parameter. Alternatively, construct a basic citation string from the item metadata (creators, year, title, publicationTitle).

**Note on PDF paths:** The Web API doesn't expose local file paths. Options:
1. Omit the PDF links (simplest for Web API)
2. Construct a Zotero URI: `zotero://open-pdf/library/items/{attachmentKey}`
3. If the user has a known Zotero storage path, construct local file paths (configurable in settings)

Default: use Zotero URI for PDF links.

**Note on Collections:** The Web API returns collection keys, not names. Fetch collection details via `GET /users/{id}/collections/{collectionKey}` to get the name. Cache collection names to avoid repeated API calls.

---

### Section 3: Abstract Callout

```markdown
> [!abstract]-
> {abstractNote with formatting}
```

Rendering logic (mirrors lines 70–73 of original template):

```
if abstractNote:
    // Bold certain structural keywords in the abstract
    abstract = abstractNote
    abstract = abstract.replace("\n", "\n>")  // keep inside callout
    abstract = stripHtml(abstract)
    abstract = abstract.replace("Objectives", "**Objectives**")
    abstract = abstract.replace("Background", "**Background**")
    abstract = abstract.replace("Methodology", "**Methodology**")
    abstract = abstract.replace("Results", "**Results**")
    abstract = abstract.replace("Conclusion", "**Conclusion**")
    
    output: '> [!abstract]-'
    output: '> {abstract}'
```

---

### Section 4: Literature Quote Callout

```markdown
> [!literature_quote]- Citations
> 
> ```query
> content: "{citekey}" -file:{citekey}
> ```
```

Static callout with Obsidian search query. Uses citekey; falls back to itemKey if no citekey.

---

### Section 5: Zotero Notes Callout

Mirrors lines 81–98 of the original template. Renders child notes (not annotations) in nested callouts.

**Data source:** From `/items/{itemKey}/children`, collect items where `data.itemType === "note"`.

**Rendering logic:**

```
longShortCutoff = 20  // configurable
longnotes = childNotes.filter(n => wordCount(stripHtml(n.data.note)) > longShortCutoff)

if longnotes.length > 0:
    output: '> [!note]- Zotero notes ({longnotes.length})'
    output: '> '
    output: '> Notes longer than {longShortCutoff} words.'

    for each note in longnotes:
        noteText = htmlToMarkdown(note.data.note)
        noteUri = constructUri(note.key)  // "zotero://select/library/items/{key}"

        // Title extraction for callout heading
        headingRegex = /^#+/
        if headingRegex.test(noteText):
            linkText = first heading text (without # prefix)
        else:
            linkText = first 30 characters of noteText, truncated

        output: '>> [!example]- Note {index} | [{linkText}]({noteUri})'

        // Body (remove first heading if used as title, prefix each line with ">> ")
        for each line in noteBody:
            output: '>> {line}'

        // Tags
        if note.data.tags.length > 0:
            output: '>>'
            output: '>> Tags:{for each tag} #{tag.tag}{comma if not last}'

        // Separator between notes
        if not last note:
            output: '>'
```

**HTML → Markdown conversion:**
- `<p>` → double newline
- `<strong>` / `<b>` → `**...**`
- `<em>` / `<i>` → `*...*`
- `<h1>`–`<h6>` → `#`–`######`
- `<br>` → newline
- `<a href="...">text</a>` → `[text](...)`
- Strip all other tags

---

### Section 6: Reading Notes (PDF Annotations)

Mirrors lines 100–169 of the original template. Color-grouped annotations.

**Rendering logic:**

```
output: '## Reading notes'
output: ''

if annotations.length > 0:
    output: '*Imported on [[{YYYY-MM-DD}]] at {HH:mm}*'

    for each (color, colorValue) in colorMap (in defined order):
        grouped = annotations.filter(a => a.annotationColor === color)
        if grouped.length === 0:
            continue

        for each annotation in grouped (sorted by annotationSortIndex):
            citationLink = '[(p. {pageLabel})]({desktopURI})'
            tagString = formatTags(annotation.tags)

            // Color heading: only before FIRST annotation
            if first in group:
                output: ''
                output: '### {colorValue.heading}'
                output: ''

            // CASE 1: Image annotation
            if annotation.annotationType === "image":
                output: ''
                output: '###### {comment}'
                output: ''
                output: '[Area highlight — see PDF] {citationLink}'
                output: ''

            // CASE 2: Has comment, NO annotatedText
            else if comment AND NOT annotationText:
                output: ''
                output: '###### {comment}'
                output: ' {citationLink}'

            // CASE 3: Has comment AND annotatedText
            else if comment AND annotationText:
                output: ''
                output: '###### {comment}'
                output: '- {symbol}  {annotationText} {citationLink}{tagString}'

            // CASE 4: annotatedText only
            else if annotationText:
                output: '- {symbol}  {annotationText} {citationLink}{tagString}'
```

**Key details:**
1. `annotationText.replace(/\s+/g, " ")` — whitespace collapsing
2. `citationLink` = `[(p. {pageLabel})]({desktopURI})` where `desktopURI` = `zotero://open-pdf/library/items/{attachmentKey}?page={pageLabel}`
3. Tags: ` #{tag}` per tag, spaces→hyphens, comma-separated
4. `######` (h6) for comments
5. Color group order follows `colorMap` definition
6. Empty groups omitted
7. **Double space** between symbol and annotationText

---

### Note about images from Web API

The Zotero Web API does not serve annotation image snapshots. For `annotationType === "image"`, render a placeholder: `[Area highlight — see PDF] {citationLink}`. Future enhancement: download via file API if available.

---

### ColorMapEntry type

```typescript
interface ColorMapEntry {
  color: string;       // e.g. "#ffd400"
  colorName: string;   // e.g. "Yellow"
  heading: string;     // e.g. "🎯 Key takeaways"
  symbol: string;      // inline color indicator for bullet items
}
```

### Color symbol rendering

The `symbol` field provides the inline color indicator prefix on annotation bullets. Default uses an HTML `<mark>` tag with matching background color + emoji:

```typescript
const DEFAULT_COLOR_MAP: ColorMapEntry[] = [
  { color: "#ffd400", colorName: "Yellow",  heading: "🎯 Key takeaways",                symbol: '<mark style="background: #ffd400">🟡</mark>' },
  { color: "#aaaaaa", colorName: "Gray",    heading: "✅ Context and target population",  symbol: '<mark style="background: #aaaaaa">⚪</mark>' },
  { color: "#5fb236", colorName: "Green",   heading: "📌 General methods and results",   symbol: '<mark style="background: #5fb236">🟢</mark>' },
  { color: "#ff6666", colorName: "Red",     heading: "🚧 Limitations",                   symbol: '<mark style="background: #ff6666">🔴</mark>' },
  { color: "#2ea8e5", colorName: "Blue",    heading: "🩺 Diagnostiek",                   symbol: '<mark style="background: #2ea8e5">🔵</mark>' },
  { color: "#f19837", colorName: "Orange",  heading: "💊 Behandeling",                   symbol: '<mark style="background: #f19837">🟠</mark>' },
];
```

Customizable in settings. Rendered as `- {symbol}  {text}` with double space.

---

## File Management Strategy

### File naming
Default: `{citekey}.md` (falls back to `{firstAuthor} {year} - {title}.md`)

### Create vs Update logic

```
On sync for item X:
  1. Compute expected filename
  2. Check if file exists in vault at outputFolder/filename.md

  IF file doesn't exist:
    → Create new file with full template (including empty ## Comments section)

  IF file exists AND item version changed:
    → Read existing file
    → Extract the "## Comments" section (everything between "## Comments" and "## Article information")
    → Re-render the entire note from fresh Zotero data
    → Splice the preserved Comments section back in
    → Write the updated file

  IF file exists AND item version unchanged:
    → Skip (no changes needed)
```

**Preservation zones:** The `## Comments` section is the only user-editable zone. Everything else is regenerated from Zotero data on each sync. The plugin identifies the section boundaries using the `## Comments` and `## Article information` headings as delimiters.

### Deletion policy
- **Never delete** notes from the vault, even if the item is removed from Zotero or the tag is removed
- Add a frontmatter flag `zotero-orphaned: true` if the item is no longer found (optional, can be toggled in settings)

---

## Commands & UI

### Ribbon icon
- Zotero sync icon in the left ribbon
- Click → triggers immediate full sync

### Commands (Cmd/Ctrl+P)

| Command | Description |
|---|---|
| `Zotero Auto-Sync: Sync now` | Immediate full sync |
| `Zotero Auto-Sync: Sync current note` | Re-sync only the note currently open (match by `zotero-key` in frontmatter) |
| `Zotero Auto-Sync: Open settings` | Jump to plugin settings |

### Status bar
- Show last sync time: "Zotero: synced 5 min ago"
- Show sync-in-progress indicator: "Zotero: syncing..."

### Notices
- On sync completion: "Zotero: synced 3 new, 2 updated"
- On error: "Zotero sync failed: [error message]"

---

## Settings Tab UI

Sections:

1. **Authentication**
   - API Key (password field)
   - User ID (text field)
   - Library type dropdown (User / Group)
   - Group ID (conditional, shown if Group selected)
   - "Test Connection" button

2. **Sync Settings**
   - Sync tag (default: `obsidian`)
   - Auto-sync interval (slider: 0–120 min, 0=off)
   - Output folder (folder picker)
   - File name template (text with variables)

3. **Color Map**
   - Table/list of color entries
   - Each row: color picker, name field, heading field
   - Add/remove/reorder buttons

4. **Advanced**
   - Preserve user content toggle
   - Mark orphaned notes toggle
   - "Clear sync cache" button (forces full re-sync)

---

## File Structure

```
obsidian-zotero-autosync/
├── src/
│   ├── main.ts                    # Plugin entry point
│   ├── settings.ts                # Settings tab UI + defaults
│   ├── types.ts                   # TypeScript interfaces
│   ├── zotero/
│   │   ├── api-client.ts          # Zotero Web API v3 HTTP client
│   │   └── types.ts               # Zotero API response types
│   ├── sync/
│   │   ├── sync-manager.ts        # Orchestrates sync cycle
│   │   └── version-tracker.ts     # Tracks library + item versions
│   ├── renderer/
│   │   └── note-renderer.ts       # Converts Zotero data → markdown
│   └── utils/
│       ├── frontmatter.ts         # Parse/update YAML frontmatter
│       └── filename.ts            # Generate safe filenames
├── styles.css                     # Minimal styles for settings
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs             # Build config (esbuild)
└── README.md
```

---

## Implementation Order (for Claude Code)

### Phase 1: Scaffold + API Client
1. Initialize from obsidian-sample-plugin template
2. Create `types.ts` with all interfaces
3. Implement `ZoteroApiClient`:
   - `fetchItemsByTag(tag, since?)` → paginated fetcher
   - `fetchItemChildren(itemKey)` → get attachments + notes
   - `fetchAnnotations(attachmentKey)` → get annotations
   - `fetchCollections()` → get all collections (cache name↔key mapping)
   - `fetchBibliography(itemKey)` → get formatted citation via `include=bib`
   - `testConnection()` → validate API key + user ID
   - Rate limiting / backoff handling
4. Basic `main.ts` with settings loading

### Phase 2: Settings
5. Implement `settings.ts` with full settings tab
6. Color map editor UI
7. Test connection button wired up

### Phase 3: Note Renderer
8. Implement `NoteRenderer`:
   - Section 0: YAML frontmatter with wiki-linked note type, citekey, title, journal, tags
   - Section 1: Persisted `## Comments` section
   - Section 2: Article information callout (Zotero/DOI/PDF links, bibliography, collections as `[[wiki links]]`, authors, reading time)
   - Section 3: Abstract callout (with bolded structural keywords)
   - Section 4: Literature quote callout with citekey query
   - Section 5: Zotero notes callout (HTML→markdown, nested callout structure)
   - Section 6: Reading notes — color-grouped annotations with all 4 rendering cases
   - Helper: tag formatting, citation links, whitespace collapsing, HTML→markdown converter

### Phase 4: Sync Manager
9. Implement `SyncManager`:
   - Full sync flow (fetch → render → write)
   - Incremental sync using `since` parameter
   - Version tracking (library-level + per-item)
   - File create vs update with `## Comments` section preservation
   - Collection name caching (fetch once, reuse)
   - Orphan detection
10. Wire up auto-sync interval (`registerInterval`)
11. Wire up manual sync command + ribbon icon

### Phase 5: Polish
12. Status bar component
13. Notices for sync results/errors
14. Error handling + retry logic
15. Edge cases: duplicate filenames, special characters, missing fields

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| API source | Zotero Web API only (not local DB) | Works without Zotero desktop open; syncs from cloud |
| HTTP client | `requestUrl` from Obsidian API | Built-in, handles CORS, works on mobile |
| Template engine | Hardcoded TypeScript | Simpler than bundling Nunjucks; your template is fixed-structure |
| Frontmatter parsing | Regex-based | Avoids dependency; frontmatter format is predictable |
| Build tool | esbuild | Standard for Obsidian plugins, fast |
| Sync strategy | Incremental via `since` + version tracking | Minimizes API calls after first sync |

---

## Edge Cases to Handle

1. **Items without PDF attachments** → Create note with metadata only, no annotation sections
2. **Items with multiple PDFs** → Merge annotations from all PDFs into one note
3. **Annotations without text** (e.g., area highlights / images) → Show comment only with page link
4. **No citekey available** → Fall back to `Author Year - Title` filename
5. **Filename conflicts** → Append itemKey if duplicate detected
6. **API key invalid / expired** → Show clear error notice + settings link
7. **Network offline** → Catch fetch errors, show notice, retry on next interval
8. **Large libraries (1000+ tagged items)** → Paginate properly, show progress
9. **Concurrent edits** → User edits note while sync runs → read file fresh before writing
10. **Group libraries** → Support via `libraryType` setting, swap URL prefix

---

## Prompt for Claude Code Desktop

Copy and give to Claude Code to start implementation:

```
Build an Obsidian plugin called "Zotero Auto-Sync" based on this plan.

Start from the obsidian-sample-plugin template (https://github.com/obsidianmd/obsidian-sample-plugin).

The plugin:
- Connects to the Zotero Web API v3 (https://api.zotero.org)
- Fetches all items tagged with a configurable tag (default: "obsidian")
- For each item, fetches children (attachments, notes, and annotations)
- Renders a markdown literature note with 7 sections (see below)
- Writes/updates the note in the vault; preserves the ## Comments section on re-sync
- Supports incremental sync via `since` parameter and `Last-Modified-Version` header
- Never deletes existing notes
- Has a ribbon icon for manual sync, auto-sync on interval, and status bar indicator
- Uses `requestUrl` from the Obsidian API for HTTP (not fetch)

Read the full plan at: obsidian-zotero-autosync-plan.md
Also read the original Nunjucks template at: Literature_note_template.md (attached)

Implementation order:
1. Scaffold project from sample-plugin template
2. Create types.ts with all TypeScript interfaces
3. Build ZoteroApiClient (src/zotero/api-client.ts) — paginated fetching, rate limiting, `since` support
4. Build settings tab (src/settings.ts) — API key, user ID, sync tag, interval, output folder, color map editor
5. Build NoteRenderer (src/renderer/note-renderer.ts) — all 7 sections
6. Build SyncManager (src/sync/sync-manager.ts) — sync cycle with ## Comments preservation
7. Wire everything in main.ts: ribbon icon, commands, auto-sync interval, status bar
8. Error handling, notices, edge cases

The note has 7 SECTIONS rendered in order. Match the original Nunjucks template exactly:

SECTION 0 — YAML Frontmatter:
---
note type: 
- "[[{conditional wiki link based on itemType}]]"
citekey: {citekey}
title: {title, colons→" -"}
authors:                                  # as wiki links
- "[[{LastName, FirstName}]]"             # or "[[{Name}]]" for institutional
journal: {publicationTitle, colons→" -"}
url: https://doi.org/{DOI}           # only if DOI exists
published: {date YYYY-MM-DD}
zotero: {dateAdded YYYY-MM-DD}
zotero-uri: https://www.zotero.org/users/{userId}/items/{itemKey}
tags:                                 # only if tags exist
- {tag with spaces→hyphens}
last-synced: {timestamp}
zotero-key: {itemKey}
---

note type wiki-link logic (single entry, NOT a list of two):
  "book" → "[[Books]]"
  "journalArticle" or "preprint" → "[[Research papers.base|Research papers]]"
  "thesis" or "bookSection" → "[[Book Sections]]"
  else → "[[{itemType camelCase-split, Title Cased}]]"

authors wiki-link logic:
  If creator has firstName + lastName → "[[LastName, FirstName]]"
  If creator has only name → "[[Name]]"

SECTION 1 — Persisted Comments:
## Comments
(preserved on re-sync — never overwritten. Identified by ## Comments → ## Article information boundaries)

SECTION 2 — Article Information Callout:
> [!info]- Info 🔗 [**Zotero**]({desktopURI}) | [**DOI**](...) | [**PDF-1**](...)
> **Bibliography**:: {formatted citation}
> **Collections**:: [[Collection1]], [[Collection2]]    ← WIKI LINKS
> **Authors**:: FirstName LastName, ...
> **Title**:: {title}
> **Journal**:: {publicationTitle}
> **Publication year**:: {YYYY}
> **First-page**:: {firstPage}          # only if page range parseable
> **Page-count**:: {pageCount}
> **Reading-time**:: {computed}

Collections must be wiki links [[name]]. Fetch collection names from API (cache them).
Page range parsing: if pages matches /(\d+)-(\d+)/, extract first page and count.
Reading time: (pageCount * 360) / 220 / 60 hours.

SECTION 3 — Abstract Callout:
> [!abstract]-
> {abstractNote with "Objectives","Background","Methodology","Results","Conclusion" bolded}

SECTION 4 — Literature Quote Callout:
> [!literature_quote]- Citations
> ```query
> content: "{citekey}" -file:{citekey}
> ```

SECTION 5 — Zotero Notes Callout:
Fetch child notes (itemType "note"). Filter for > 20 words after HTML stripping.
Render as nested callouts matching original template exactly.
Convert Zotero HTML notes to markdown.

SECTION 6 — Reading Notes:
## Reading notes
*Imported on [[{YYYY-MM-DD}]] at {HH:mm}*

For each color in colorMap order, if annotations exist:
### {heading}

Cases (sorted by annotationSortIndex):
1. Image → placeholder: [Area highlight — see PDF] {citationLink}
2. Comment only → ###### {comment}\n {citationLink}
3. Comment + text → ###### {comment}\n- {symbol}  {text} {citationLink}{tags}
4. Text only → - {symbol}  {text} {citationLink}{tags}

Symbol is colorMap entry's symbol field (default: '<mark style="background: {color}">{emoji}</mark>')
Double space between symbol and text. Whitespace collapsed in annotatedText.

Color map default:
  #ffd400 Yellow  → "🎯 Key takeaways"
  #aaaaaa Gray    → "✅ Context and target population"
  #5fb236 Green   → "📌 General methods and results"
  #ff6666 Red     → "🚧 Limitations"
  #2ea8e5 Blue    → "🩺 Diagnostiek"
  #f19837 Orange  → "💊 Behandeling"

Use Obsidian's `requestUrl` for all HTTP calls, not `fetch`.
```
