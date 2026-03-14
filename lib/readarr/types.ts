export type ReadarrMediaCover = {
  coverType?: string | null;
  url?: string | null;
  remoteUrl?: string | null;
};

export type ReadarrEdition = {
  id?: number;
  bookId?: number;
  foreignEditionId?: string | null;
  title?: string | null;
  language?: string | null;
  format?: string | null;
  isEbook?: boolean;
  overview?: string | null;
  releaseDate?: string | null;
  monitored?: boolean;
  remoteCover?: string | null;
  images?: ReadarrMediaCover[] | null;
};

export type ReadarrAddAuthorOptions = {
  monitor?: string | null;
  booksToMonitor?: string[] | null;
  monitored?: boolean;
  searchForMissingBooks?: boolean;
};

export type ReadarrAddBookOptions = {
  addType?: "automatic" | "manual";
  searchForNewBook?: boolean;
};

export type ReadarrAuthor = {
  id?: number;
  authorName: string;
  authorNameLastFirst?: string | null;
  foreignAuthorId: string;
  titleSlug?: string | null;
  monitored?: boolean;
  monitorNewItems?: string | null;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string | null;
  path?: string | null;
  folder?: string | null;
  remotePoster?: string | null;
  images?: ReadarrMediaCover[] | null;
  addOptions?: ReadarrAddAuthorOptions | null;
};

export type ReadarrBookStatistics = {
  bookFileCount?: number | null;
  bookCount?: number | null;
  totalBookCount?: number | null;
  sizeOnDisk?: number | null;
};

export type ReadarrLookupBook = {
  id?: number;
  title: string;
  authorId?: number;
  foreignBookId: string;
  foreignEditionId?: string | null;
  titleSlug?: string | null;
  disambiguation?: string | null;
  monitored?: boolean;
  anyEditionOk?: boolean;
  releaseDate?: string | null;
  remoteCover?: string | null;
  images?: ReadarrMediaCover[] | null;
  lastSearchTime?: string | null;
  author: ReadarrAuthor;
  editions?: ReadarrEdition[] | null;
  statistics?: ReadarrBookStatistics | null;
  addOptions?: ReadarrAddBookOptions | null;
};

export type ReadarrQueueItem = {
  id: number;
  bookId?: number | null;
  title?: string | null;
  status?: string | null;
  trackedDownloadStatus?: string | null;
  trackedDownloadState?: string | null;
  errorMessage?: string | null;
  timeleft?: string | null;
  estimatedCompletionTime?: string | null;
};

export type ReadarrBookFile = {
  id: number;
  bookId?: number | null;
  path?: string | null;
  relativePath?: string | null;
  size?: number | null;
  quality?: {
    quality?: {
      name?: string | null;
    } | null;
  } | null;
};

export type ReadarrQualityProfile = {
  id: number;
  name: string;
};

export type ReadarrMetadataProfile = {
  id: number;
  name: string;
};

export type ReadarrRootFolder = {
  id: number;
  path: string;
  name?: string | null;
  defaultQualityProfileId?: number | null;
  defaultMetadataProfileId?: number | null;
};

export type ReadarrSystemStatus = {
  version?: string | null;
  appName?: string | null;
  instanceName?: string | null;
};
