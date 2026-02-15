export const SECRET_KEY_ID = 'zotero-connector-api-key';

export interface ZoteroAutoSyncSettings {
  // Auth (API key stored in Obsidian SecretStorage, not here)
  userId: string;
  libraryType: 'user' | 'group';
  groupId: string;

  // Sync behavior
  syncTag: string;
  autoSyncIntervalMinutes: number;
  outputFolder: string;
  fileNameTemplate: string;

  // Template
  templatePath: string;
  colorMap: ColorMapEntry[];
  longNoteCutoff: number;

  // Image annotations
  imageOutputFolder: string;
  zoteroCacheDirs: Record<string, string>; // hostname → local Zotero cache path

  // Advanced
  preserveUserContent: boolean;
  markOrphaned: boolean;

  // Internal
  lastSyncVersion: number;
  itemVersions: Record<string, number>;
  itemFilenames: Record<string, string>;
  lastSyncedTags: Record<string, string[]>;
}

export interface ColorMapEntry {
  color: string;
  colorName: string;
  heading: string;
  symbol: string;
}

export const DEFAULT_COLOR_MAP: ColorMapEntry[] = [
  { color: "#ffd400", colorName: "Yellow",  heading: "\u{1F3AF} Key takeaways",                symbol: '<mark style="background: #ffd400">\u{1F7E1}</mark>' },
  { color: "#aaaaaa", colorName: "Gray",    heading: "\u2705 Context and target population",  symbol: '<mark style="background: #aaaaaa">\u26AA</mark>' },
  { color: "#5fb236", colorName: "Green",   heading: "\u{1F4CC} General methods and results",   symbol: '<mark style="background: #5fb236">\u{1F7E2}</mark>' },
  { color: "#ff6666", colorName: "Red",     heading: "\u{1F6A7} Limitations",                   symbol: '<mark style="background: #ff6666">\u{1F534}</mark>' },
  { color: "#2ea8e5", colorName: "Blue",    heading: "\u{1FA7A} Diagnostiek",                   symbol: '<mark style="background: #2ea8e5">\u{1F535}</mark>' },
  { color: "#f19837", colorName: "Orange",  heading: "\u{1F48A} Behandeling",                   symbol: '<mark style="background: #f19837">\u{1F7E0}</mark>' },
];

export const DEFAULT_SETTINGS: ZoteroAutoSyncSettings = {
  userId: '',
  libraryType: 'user',
  groupId: '',

  syncTag: 'obsidian',
  autoSyncIntervalMinutes: 30,
  outputFolder: 'Zotero Literature Notes',
  fileNameTemplate: '{{citekey}}',

  templatePath: '',
  colorMap: [...DEFAULT_COLOR_MAP],
  longNoteCutoff: 20,

  imageOutputFolder: 'Maintenance/Attachments',
  zoteroCacheDirs: {},

  preserveUserContent: true,
  markOrphaned: false,

  lastSyncVersion: 0,
  itemVersions: {},
  itemFilenames: {},
  lastSyncedTags: {},
};
