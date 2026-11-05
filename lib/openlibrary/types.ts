export type OpenLibraryAuthorRef = {
  key: string;
  name: string;
};

export type OpenLibraryBookCandidate = {
  key: string;
  title: string;
  authors: OpenLibraryAuthorRef[];
  firstPublishYear: number | null;
  coverUrl: string | null;
};

export type OpenLibraryAuthorCandidate = {
  key: string;
  name: string;
  topWork: string | null;
  workCount: number | null;
};

export type OpenLibraryRequestOptions = {
  signal?: AbortSignal;
};
