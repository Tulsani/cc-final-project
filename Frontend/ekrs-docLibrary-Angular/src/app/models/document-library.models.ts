export interface DocumentTag {
  key: string;
  value: string;
}

export interface LibraryFile {
  fileId: string;
  fileName: string;
  clientId: string;
  userId: string;
  bankerId: string;
  prospectId: string;
  fileType: string;
  fileSubType: string;
  docType: string;
  stage: string;
  uploadedBy: string;
  parentFolder: string;
  description: string;
  tags: DocumentTag[];
  linked: boolean;
  mimeType: string;
  extension: string;
  fileSize: number;
  s3Key: string;
  s3Bucket: string;
  uploadStatus: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface LibraryFolder {
  name: string;
  path: string;
  fileCount: number;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface ListFolderResponse {
  requestType: 'list-folder';
  clientId: string;
  currentFolder: string;
  breadcrumbs: Breadcrumb[];
  folders: LibraryFolder[];
  files: LibraryFile[];
  scanned: {
    pages: number;
    hasMore: boolean;
    note?: string;
  };
}

export interface GetFileResponse {
  requestType: 'get-file';
  file: LibraryFile;
  viewUrl: string;
  expiresIn: number;
}

export interface UploadMetadata {
  clientId: string;
  userId: string;
  fileType: string;
  fileSubType: string;
  docType: string;
  stage: string;
  bankerId: string;
  prospectId: string;
  parentFolder: string;
  uploadedBy: string;
  linked: boolean;
  description: string;
  tags: DocumentTag[];
}

export interface PresignUploadResponse {
  fileId: string;
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
  metadata: LibraryFile & {
    searchString?: string;
  };
}

export interface SearchChunkResult {
  datapointId: string;
  score: number;
  rank: number;
  fileId: string;
  clientId: string;
  userId: string;
  bankerId: string;
  prospectId: string;
  fileType: string;
  docType: string;
  stage: string;
  tags: DocumentTag[];
  chunkIndex: number;
  totalChunks: number;
  wordCount: number;
  startWord: number;
  endWord: number;
  chunkS3Key: string;
  chunksBucket: string;
  sourceS3Key: string;
  sourceS3Bucket: string;
  textractJobId: string;
  text: string;
  embeddedAt: string;
}

export interface ShortSearchResponse {
  answer: string;
  results: SearchChunkResult[];
  query: string;
  filters: Record<string, unknown>;
  topK: number;
  took_ms: number;
}

export interface LongSearchTaskStart {
  taskId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | string;
  peerCount?: number;
  strategy?: string;
  pollUrl?: string;
}

export interface LongSearchSection {
  peerIndex: number;
  assignedFiles: string[];
  answer: string;
  took_ms: number;
}

export interface LongSearchTaskResponse {
  id?: string;
  taskId: string;
  query: string;
  filters: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed' | string;
  finalAnswer?: string;
  peerCount?: number;
  synthesisedBy?: string;
  completedAt?: string;
  infrastructure?: Record<string, string>;
  sections?: LongSearchSection[];
  error?: string;
}
