import { ZoteroItem, ZoteroCreator, SyncItemData } from '../zotero/types';
import { ZoteroAutoSyncSettings, ColorMapEntry } from '../types';

const READING_SPEED = 220; // words per minute
const WORDS_PER_PAGE = 360;

export class NoteRenderer {
  private settings: ZoteroAutoSyncSettings;

  constructor(settings: ZoteroAutoSyncSettings) {
    this.settings = settings;
  }

  updateSettings(settings: ZoteroAutoSyncSettings): void {
    this.settings = settings;
  }

  render(syncData: SyncItemData): string {
    const sections: string[] = [];

    sections.push(this.renderFrontmatter(syncData));
    sections.push(this.renderCommentsSection());
    sections.push(this.renderArticleInfo(syncData));
    sections.push(this.renderAbstract(syncData));
    sections.push(this.renderLiteratureQuote(syncData));
    sections.push(this.renderZoteroNotes(syncData));
    sections.push(this.renderReadingNotes(syncData));

    return sections.join('\n');
  }

  // ── Section 0: YAML Frontmatter ──────────────────────────────────────

  private renderFrontmatter(syncData: SyncItemData): string {
    const { item } = syncData;
    const d = item.data;
    const lines: string[] = ['---'];

    // note type
    const noteType = this.getNoteTypeWikiLink(d.itemType);
    lines.push('note type: ');
    lines.push(`- "${noteType}"`);

    // citekey
    const citekey = syncData.citekey || this.extractCitekey(d);
    lines.push(`citekey: ${citekey}`);

    // title
    lines.push(`title: ${this.yamlSafe(d.title || '')}`);

    // authors
    if (d.creators && d.creators.length > 0) {
      lines.push('authors:');
      for (const creator of d.creators) {
        const authorLink = this.formatCreatorWikiLink(creator);
        lines.push(`- "${authorLink}"`);
      }
    }

    // journal
    if (d.publicationTitle) {
      lines.push(`journal: ${this.yamlSafe(d.publicationTitle)}`);
    }

    // url (DOI-based)
    if (d.DOI) {
      lines.push(`url: https://doi.org/${d.DOI}`);
    }

    // published date
    const publishedDate = this.formatDate(d.date);
    if (publishedDate) {
      lines.push(`published: ${publishedDate}`);
    }

    // zotero (dateAdded)
    const zoteroDate = this.formatDateISO(d.dateAdded);
    if (zoteroDate) {
      lines.push(`zotero: ${zoteroDate}`);
    }

    // zotero-uri
    const zoteroUri = this.buildDesktopUri(item.key);
    lines.push(`zotero-uri: ${zoteroUri}`);

    // tags
    const tags = (d.tags || []).filter(t => t.tag !== this.settings.syncTag);
    if (tags.length > 0) {
      lines.push('tags: ');
      for (const tag of tags) {
        const formattedTag = tag.tag.replace(/\s+/g, '-');
        lines.push(`- ${formattedTag}`);
      }
    }

    // last-synced
    const now = new Date();
    lines.push(`last-synced: ${now.toISOString()}`);

    // zotero-key
    lines.push(`zotero-key: ${item.key}`);

    lines.push('---');
    return lines.join('\n');
  }

  private getNoteTypeWikiLink(itemType: string): string {
    switch (itemType) {
      case 'book':
        return '[[Books]]';
      case 'journalArticle':
      case 'preprint':
        return '[[Research papers.base|Research papers]]';
      case 'thesis':
      case 'bookSection':
        return '[[Book Sections]]';
      default: {
        // Split camelCase and title-case
        const split = itemType.replace(/([a-z])([A-Z])/g, '$1 $2');
        const titleCased = split.charAt(0).toUpperCase() + split.slice(1);
        return `[[${titleCased}]]`;
      }
    }
  }

  private formatCreatorWikiLink(creator: ZoteroCreator): string {
    if (creator.lastName && creator.firstName) {
      return `[[${creator.lastName}, ${creator.firstName}]]`;
    }
    if (creator.name) {
      return `[[${creator.name}]]`;
    }
    if (creator.lastName) {
      return `[[${creator.lastName}]]`;
    }
    return '[[Unknown Author]]';
  }

  private extractCitekey(data: ZoteroItem['data']): string {
    // Citekey is often stored in the 'extra' field as "Citation Key: xyz"
    if (data.extra) {
      const match = data.extra.match(/Citation Key:\s*(.+)/i);
      if (match) {
        return match[1].trim();
      }
    }
    // Fallback: construct from first author + year
    const firstAuthor = data.creators?.[0];
    const year = this.extractYear(data.date);
    if (firstAuthor) {
      const name = firstAuthor.lastName || firstAuthor.name || 'Unknown';
      const capitalized = this.capitalizeHyphenated(name);
      return `${capitalized}_${year || ''}`;
    }
    return data.key;
  }

  private capitalizeHyphenated(name: string): string {
    return name.split('-').map(seg =>
      seg.length > 0 ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg
    ).join('-');
  }

  private formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '';
    // Try ISO parse
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    // Try to extract just year
    const yearMatch = dateStr.match(/(\d{4})/);
    if (yearMatch) return yearMatch[1];
    return '';
  }

  private formatDateISO(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    return '';
  }

  private extractYear(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const m = dateStr.match(/(\d{4})/);
    return m ? m[1] : '';
  }

  private buildWebUri(itemKey: string): string {
    if (this.settings.libraryType === 'group' && this.settings.groupId) {
      return `https://www.zotero.org/groups/${this.settings.groupId}/items/${itemKey}`;
    }
    return `https://www.zotero.org/users/${this.settings.userId}/items/${itemKey}`;
  }

  private buildDesktopUri(itemKey: string): string {
    if (this.settings.libraryType === 'group' && this.settings.groupId) {
      return `zotero://select/groups/${this.settings.groupId}/items/${itemKey}`;
    }
    return `zotero://select/library/items/${itemKey}`;
  }

  private buildPdfUri(attachmentKey: string, page?: string): string {
    const base = this.settings.libraryType === 'group' && this.settings.groupId
      ? `zotero://open-pdf/groups/${this.settings.groupId}/items/${attachmentKey}`
      : `zotero://open-pdf/library/items/${attachmentKey}`;
    if (page) {
      return `${base}?page=${page}`;
    }
    return base;
  }

  // ── Section 1: Persisted Comments ────────────────────────────────────

  private renderCommentsSection(): string {
    return '\n%% begin Comments %%\n## Comments \n\n%% end Comments %%';
  }

  // ── Section 2: Article Information Callout ───────────────────────────

  private renderArticleInfo(syncData: SyncItemData): string {
    const { item, children, collectionNames, bibliography } = syncData;
    const d = item.data;
    const lines: string[] = [];

    // Header line with links
    const desktopUri = this.buildDesktopUri(item.key);
    let header = `> [!info]- Info \u{1F517} [**Zotero**](${desktopUri})`;

    if (d.DOI) {
      header += ` | [**DOI**](https://doi.org/${d.DOI})`;
    }

    // PDF attachments
    const pdfAttachments = children.filter(
      c => c.data.itemType === 'attachment' && c.data.contentType === 'application/pdf'
    );
    pdfAttachments.forEach((att, idx) => {
      const pdfUri = this.buildPdfUri(att.key);
      header += ` | [**PDF-${idx + 1}**](${pdfUri})`;
    });

    lines.push(header);
    lines.push('>');

    // Bibliography
    if (bibliography) {
      lines.push(`>**Bibliography**:: ${bibliography}`);
      lines.push('>');
    }

    // Collections as wiki links
    if (collectionNames.length > 0) {
      const colLinks = collectionNames.map(name => `[[${name}]]`).join(', ');
      lines.push(`> **Collections**:: ${colLinks}`);
    }

    // Page range parsing
    let firstPage: string | null = null;
    let pageCount = 0;

    if (d.pages) {
      const rangeMatch = d.pages.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (rangeMatch) {
        firstPage = rangeMatch[1];
        pageCount = parseInt(rangeMatch[2], 10) - parseInt(rangeMatch[1], 10);
      } else {
        const singlePage = parseInt(d.pages, 10);
        if (!isNaN(singlePage)) {
          pageCount = singlePage;
        }
      }
    } else if (d.numPages) {
      const np = parseInt(d.numPages, 10);
      if (!isNaN(np)) {
        pageCount = np;
      }
    }

    // Authors/Title/Journal block (shown if firstPage was determined)
    if (firstPage) {
      const authorsList = (d.creators || [])
        .map(c => c.firstName && c.lastName ? `${c.firstName} ${c.lastName}` : c.name || c.lastName || '')
        .filter(Boolean)
        .join(', ');

      lines.push('>');
      lines.push(`> **Authors**:: ${authorsList}`);
      lines.push('> ');
      lines.push(`> **Title**:: ${d.title || ''}`);
      lines.push('> ');
      lines.push(`> **Journal**:: ${d.publicationTitle || ''}`);
      lines.push('> ');
      lines.push(`> **Publication year**:: ${this.extractYear(d.date)}`);
      lines.push('> ');
      lines.push(`> **First-page**:: ${firstPage}`);
    }

    // Reading time block (shown if pageCount > 0)
    if (pageCount > 0) {
      const readingTimeHours = (pageCount * WORDS_PER_PAGE / READING_SPEED) / 60;
      lines.push('> ');
      lines.push(`> **Page-count**:: ${pageCount}`);

      if (readingTimeHours < 1) {
        const minutes = Math.round(readingTimeHours * 60);
        lines.push(`> **Reading-time**:: ${minutes} minutes`);
      } else {
        const rounded = Math.round(readingTimeHours * 1000) / 1000;
        lines.push(`> **Reading-time**:: ${rounded} hours`);
      }
    }

    return lines.join('\n');
  }

  // ── Section 3: Abstract Callout ──────────────────────────────────────

  private renderAbstract(syncData: SyncItemData): string {
    const abstract = syncData.item.data.abstractNote;
    if (!abstract) return '';

    let text = this.stripHtml(abstract);

    // Bold structural keywords
    const keywords = ['Objectives', 'Background', 'Methodology', 'Results', 'Conclusion'];
    for (const kw of keywords) {
      text = text.replace(new RegExp(`\\b${kw}\\b`, 'g'), `**${kw}**`);
    }

    // Keep inside callout
    const calloutBody = text.replace(/\n/g, '\n> ');

    return `\n> [!abstract]-\n> ${calloutBody}`;
  }

  // ── Section 4: Literature Quote Callout ──────────────────────────────

  private renderLiteratureQuote(syncData: SyncItemData): string {
    const citekey = syncData.citekey || this.extractCitekey(syncData.item.data);
    return [
      '',
      '> [!literature_quote]- Citations',
      '> ',
      '> ```query',
      `> content: "${citekey}" -file:${citekey}`,
      '> ```',
    ].join('\n');
  }

  // ── Section 5: Zotero Notes Callout ──────────────────────────────────

  private renderZoteroNotes(syncData: SyncItemData): string {
    const { children } = syncData;
    const cutoff = this.settings.longNoteCutoff;

    // Filter for note-type children
    const childNotes = children.filter(c => c.data.itemType === 'note');

    // Filter for "long" notes
    const longNotes = childNotes.filter(n => {
      const plain = this.stripHtml(n.data.note || '');
      return this.wordCount(plain) > cutoff;
    });

    if (longNotes.length === 0) return '';

    const lines: string[] = [
      '',
      `> [!note]- Zotero notes (${longNotes.length})`,
      '> ',
      `> Notes longer than ${cutoff} words.`,
    ];

    longNotes.forEach((note, idx) => {
      const noteText = this.htmlToMarkdown(note.data.note || '');
      const noteUri = this.buildDesktopUri(note.key);

      // Extract title for callout heading
      let linkText: string;
      const headingMatch = noteText.match(/^(#+)\s*(.*)/m);
      if (headingMatch) {
        linkText = headingMatch[2].trim();
      } else {
        linkText = noteText.substring(0, 30).trim();
        if (noteText.length > 30) linkText += '...';
      }

      lines.push(`>> [!example]- Note ${idx + 1} | [${linkText}](${noteUri})`);

      // Body: remove first heading if used as title, prefix each line
      let body = noteText;
      if (headingMatch) {
        body = body.replace(/^#+\s*.*\n?/, '');
      }

      const bodyLines = body.split('\n');
      for (const line of bodyLines) {
        lines.push(`>> ${line}`);
      }

      // Tags
      const tags = note.data.tags || [];
      if (tags.length > 0) {
        lines.push('>>');
        const tagStr = tags.map(t => `#${t.tag.replace(/\s+/g, '-')}`).join(', ');
        lines.push(`>> Tags: ${tagStr}`);
      }

      // Separator between notes
      if (idx < longNotes.length - 1) {
        lines.push('>');
      }
    });

    return lines.join('\n');
  }

  // ── Section 6: Reading Notes (PDF Annotations) ──────────────────────

  private renderReadingNotes(syncData: SyncItemData): string {
    const { annotations } = syncData;
    const lines: string[] = ['', '## Reading notes', ''];

    if (annotations.length === 0) {
      return lines.join('\n');
    }

    // Import timestamp
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().substring(0, 5);
    lines.push(`*Imported on [[${dateStr}]] at ${timeStr}*`);

    // Process each color group in colorMap order
    for (const colorEntry of this.settings.colorMap) {
      const grouped = annotations
        .filter(a => a.data.annotationColor === colorEntry.color)
        .sort((a, b) => (a.data.annotationSortIndex || '').localeCompare(b.data.annotationSortIndex || ''));

      if (grouped.length === 0) continue;

      lines.push('');
      lines.push(`### ${colorEntry.heading}`);
      lines.push('');

      for (const ann of grouped) {
        const d = ann.data;
        const comment = d.annotationComment || '';
        const text = d.annotationText ? d.annotationText.replace(/\s+/g, ' ').trim() : '';
        const pageLabel = d.annotationPageLabel || '';
        const attachmentKey = d.parentItem || '';
        const citationLink = `[(p. ${pageLabel})](${this.buildPdfUri(attachmentKey, pageLabel)})`;
        const tagString = this.formatAnnotationTags(d.tags);

        if (d.annotationType === 'image') {
          // CASE 1: Image annotation
          const imagePath = syncData.annotationImages?.get(ann.key);
          const annotationLink = `[Image (p. ${pageLabel})](${this.buildPdfUri(attachmentKey, pageLabel)}&annotation=${ann.key})`;
          lines.push('');
          if (comment) {
            lines.push(`###### ${comment}`);
            lines.push('');
          }
          if (imagePath) {
            lines.push(annotationLink);
            lines.push(`![[${imagePath}]]`);
          } else {
            lines.push(`[Image \u2014 see PDF] ${annotationLink}`);
          }
          lines.push('');
        } else if (comment && !text) {
          // CASE 2: Comment only, no text
          lines.push('');
          lines.push(`###### ${comment}`);
          lines.push(` ${citationLink}`);
        } else if (comment && text) {
          // CASE 3: Comment + text
          lines.push('');
          lines.push(`###### ${comment}`);
          lines.push(`- ${text} ${citationLink}${tagString}`);
        } else if (text) {
          // CASE 4: Text only
          lines.push(`- ${text} ${citationLink}${tagString}`);
        }
      }
    }

    // Handle annotations with colors not in the colorMap
    const knownColors = new Set(this.settings.colorMap.map(c => c.color));
    const unmapped = annotations.filter(a => !knownColors.has(a.data.annotationColor || ''));
    if (unmapped.length > 0) {
      lines.push('');
      lines.push('### Other annotations');
      lines.push('');

      for (const ann of unmapped.sort((a, b) =>
        (a.data.annotationSortIndex || '').localeCompare(b.data.annotationSortIndex || ''))) {
        const d = ann.data;
        const text = d.annotationText ? d.annotationText.replace(/\s+/g, ' ').trim() : '';
        const pageLabel = d.annotationPageLabel || '';
        const attachmentKey = d.parentItem || '';
        const citationLink = `[(p. ${pageLabel})](${this.buildPdfUri(attachmentKey, pageLabel)})`;
        const tagString = this.formatAnnotationTags(d.tags);
        if (d.annotationType === 'image') {
          const imagePath = syncData.annotationImages?.get(ann.key);
          const annotationLink = `[Image (p. ${pageLabel})](${this.buildPdfUri(attachmentKey, pageLabel)}&annotation=${ann.key})`;
          if (imagePath) {
            lines.push(annotationLink);
            lines.push(`![[${imagePath}]]`);
          } else {
            lines.push(`[Image \u2014 see PDF] ${annotationLink}`);
          }
        } else if (text) {
          lines.push(`- ${text} ${citationLink}${tagString}`);
        }
      }
    }

    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Quote a string for safe use as a YAML value in Obsidian frontmatter.
   *  Wraps in double quotes if the value contains YAML-special characters. */
  private yamlSafe(value: string): string {
    if (!value) return '""';
    // Characters that make a bare YAML value ambiguous or invalid
    if (/[:#\[\]{}&*!|>'"%@`,\n]/.test(value) || value.trimStart() !== value || value.trimEnd() !== value) {
      // Escape existing double quotes and backslashes, then wrap
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return value;
  }

  private formatAnnotationTags(tags: Array<{ tag: string }> | undefined): string {
    if (!tags || tags.length === 0) return '';
    return ' ' + tags.map(t => `#${t.tag.replace(/\s+/g, '-')}`).join(', ');
  }

  private wordCount(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  htmlToMarkdown(html: string): string {
    let md = html;

    // Headings
    md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
    md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
    md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
    md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n');
    md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n');
    md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n');

    // Bold / italic
    md = md.replace(/<(strong|b)>(.*?)<\/(strong|b)>/gi, '**$2**');
    md = md.replace(/<(em|i)>(.*?)<\/(em|i)>/gi, '*$2*');

    // Links
    md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    // Line breaks and paragraphs
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<\/p>/gi, '\n\n');
    md = md.replace(/<p[^>]*>/gi, '');

    // Strip remaining tags
    md = md.replace(/<[^>]+>/g, '');

    // Decode entities
    md = md.replace(/&amp;/g, '&');
    md = md.replace(/&lt;/g, '<');
    md = md.replace(/&gt;/g, '>');
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&nbsp;/g, ' ');

    // Collapse excessive newlines
    md = md.replace(/\n{3,}/g, '\n\n');

    return md.trim();
  }

  // ── Template Rendering ──────────────────────────────────────────────

  renderFromTemplate(syncData: SyncItemData, template: string): string {
    const placeholders = this.buildPlaceholderMap(syncData);
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return key in placeholders ? placeholders[key] : match;
    });
  }

  private buildPlaceholderMap(syncData: SyncItemData): Record<string, string> {
    const { item, children, annotations, collectionNames, bibliography } = syncData;
    const d = item.data;
    const now = new Date();

    const citekey = syncData.citekey || this.extractCitekey(d);
    const noteTypeWikilink = this.getNoteTypeWikiLink(d.itemType);

    // Authors formatted
    const authorsWikilinks = (d.creators || [])
      .map(c => this.formatCreatorWikiLink(c))
      .join(', ');
    const authorsPlain = (d.creators || [])
      .map(c => c.firstName && c.lastName ? `${c.firstName} ${c.lastName}` : c.name || c.lastName || '')
      .filter(Boolean)
      .join(', ');

    // Tags
    const tags = (d.tags || []).filter(t => t.tag !== this.settings.syncTag);
    const tagsYaml = tags.map(t => `- ${t.tag.replace(/\s+/g, '-')}`).join('\n');
    const tagsInline = tags.map(t => `#${t.tag.replace(/\s+/g, '-')}`).join(' ');

    // PDF links
    const pdfAttachments = children.filter(
      c => c.data.itemType === 'attachment' && c.data.contentType === 'application/pdf'
    );
    const pdfLinks = pdfAttachments.map((att, idx) => {
      const pdfUri = this.buildPdfUri(att.key);
      return `[PDF-${idx + 1}](${pdfUri})`;
    }).join(' | ');

    // Collections
    const collectionsWikilinks = collectionNames.map(name => `[[${name}]]`).join(', ');

    // Page info
    let pageInfo = '';
    if (d.pages) {
      pageInfo = d.pages;
    } else if (d.numPages) {
      pageInfo = `${d.numPages} pages`;
    }

    const map: Record<string, string> = {
      // Simple fields
      citekey,
      title: this.yamlSafe(d.title || ''),
      journal: this.yamlSafe(d.publicationTitle || ''),
      doi: d.DOI || '',
      url: d.DOI ? `https://doi.org/${d.DOI}` : (d.url || ''),
      published: this.formatDate(d.date),
      date_added: this.formatDateISO(d.dateAdded),
      abstract: d.abstractNote ? this.stripHtml(d.abstractNote) : '',
      zotero_uri: this.buildDesktopUri(item.key),
      desktop_uri: this.buildDesktopUri(item.key),
      zotero_key: item.key,
      item_type: d.itemType,
      note_type_wikilink: noteTypeWikilink,
      last_synced: now.toISOString(),
      import_date: now.toISOString().split('T')[0],
      import_time: now.toTimeString().substring(0, 5),

      // Formatted blocks
      comments_section: this.renderCommentsSection(),
      frontmatter: this.renderFrontmatter(syncData),
      authors_wikilinks: authorsWikilinks,
      authors_plain: authorsPlain,
      tags_yaml: tagsYaml,
      tags_inline: tagsInline,
      article_info_callout: this.renderArticleInfo(syncData),
      abstract_callout: this.renderAbstract(syncData),
      literature_quote_callout: this.renderLiteratureQuote(syncData),
      zotero_notes_callout: this.renderZoteroNotes(syncData),
      reading_notes: this.renderReadingNotes(syncData).replace(/^\n## Reading notes\n/, ''),
      pdf_links: pdfLinks,
      bibliography: bibliography || '',
      collections_wikilinks: collectionsWikilinks,
      page_info: pageInfo,
    };

    return map;
  }

  /**
   * Re-render a note while preserving the user's ## Comments section.
   * Finds content between "## Comments" and the next "## " heading in both
   * old and new content, then transplants the old comments into the new output.
   * If newContent is not provided, uses the built-in renderer.
   */
  renderWithPreservedComments(
    syncData: SyncItemData,
    existingContent: string,
    newContent?: string
  ): string {
    const rendered = newContent ?? this.render(syncData);

    // Extract preserved comments from existing file
    const oldRange = this.findCommentsRange(existingContent);
    if (!oldRange) return rendered;

    let preservedComments = existingContent.substring(oldRange.start, oldRange.end);

    // Auto-migrate: if old content uses bare ## Comments (no %% markers), wrap it
    if (!preservedComments.includes('%% begin Comments %%')) {
      preservedComments = `%% begin Comments %%\n${preservedComments}\n%% end Comments %%`;
    }

    // Find corresponding range in the new content
    const newRange = this.findCommentsRange(rendered);
    if (!newRange) {
      console.warn(
        '[Zotero Connector] New content/template has no "## Comments" section — ' +
        'user comments cannot be preserved. Add a "## Comments" heading to your template.'
      );
      return rendered;
    }

    return rendered.substring(0, newRange.start) +
      preservedComments +
      rendered.substring(newRange.end);
  }

  /**
   * Find the byte range of the comments section.
   * Tries `%% begin Comments %%` / `%% end Comments %%` markers first,
   * then falls back to the old `## Comments` heading for backward compat.
   */
  private findCommentsRange(content: string): { start: number; end: number } | null {
    // Try %% markers first
    const markerStart = content.indexOf('%% begin Comments %%');
    if (markerStart !== -1) {
      const markerEnd = content.indexOf('%% end Comments %%', markerStart);
      if (markerEnd !== -1) {
        return { start: markerStart, end: markerEnd + '%% end Comments %%'.length };
      }
    }

    // Fallback: old-style ## Comments heading
    const commentsStart = content.indexOf('## Comments');
    if (commentsStart === -1) return null;

    // Find the next ## heading after the comments heading line
    const afterHeading = content.indexOf('\n', commentsStart);
    if (afterHeading === -1) return { start: commentsStart, end: content.length };

    const nextHeading = content.indexOf('\n## ', afterHeading);
    const end = nextHeading === -1 ? content.length : nextHeading + 1;

    return { start: commentsStart, end };
  }
}
