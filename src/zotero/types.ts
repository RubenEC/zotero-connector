export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroTag {
  tag: string;
  type?: number;
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  abstractNote?: string;
  publicationTitle?: string;
  date?: string;
  DOI?: string;
  url?: string;
  pages?: string;
  numPages?: string;
  volume?: string;
  issue?: string;
  creators?: ZoteroCreator[];
  tags?: ZoteroTag[];
  collections?: string[];
  dateAdded?: string;
  dateModified?: string;
  extra?: string;
  parentItem?: string;

  // Annotation fields
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  annotationPosition?: string;

  // Note fields
  note?: string;

  // Attachment fields
  contentType?: string;
  filename?: string;
  path?: string;
  linkMode?: string;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: {
    type: string;
    id: number;
    name: string;
  };
  links?: {
    self?: { href: string };
    alternate?: { href: string };
    up?: { href: string };
  };
  meta?: {
    creatorSummary?: string;
    parsedDate?: string;
    numChildren?: number;
  };
  data: ZoteroItemData;
  bib?: string;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: {
    key: string;
    name: string;
    parentCollection?: string | false;
  };
}

export interface ZoteroApiResponse<T> {
  items: T[];
  totalResults: number;
  lastModifiedVersion: number;
}

export interface SyncItemData {
  item: ZoteroItem;
  children: ZoteroItem[];
  annotations: ZoteroItem[];
  collectionNames: string[];
  bibliography: string;
  annotationImages?: Map<string, string>; // annotation key → vault-relative image path
  citekey?: string; // override citekey from stored filename
}
