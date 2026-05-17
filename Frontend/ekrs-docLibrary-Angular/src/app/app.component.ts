import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { environment } from '../environments/environment';
import {
  Breadcrumb,
  DocumentTag,
  LibraryFile,
  LibraryFolder,
  LongSearchSection,
  SearchChunkResult,
  UploadMetadata,
} from './models/document-library.models';
import { DocumentLibraryService } from './services/document-library.service';

type LoadState = 'idle' | 'loading' | 'uploading' | 'viewing';
type SearchMode = 'short' | 'long';
type SearchState = 'idle' | 'searching' | 'thinking' | 'done';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  readonly appTitle = 'KRS Document Library';

  clientId = 'client_acme_001';
  userId = 'user_jane_xyz789';
  uploadedBy = 'Jane Smith';
  bankerId = 'banker_john_001';
  prospectId = 'prospect_deal_42';

  currentFolder = '';
  folderInput = 'deals/2024/q2';
  newFolderName = '';
  search = '';
  status = '';

  folders: LibraryFolder[] = [];
  files: LibraryFile[] = [];
  breadcrumbs: Breadcrumb[] = [{ name: 'root', path: '' }];

  selectedFile: LibraryFile | null = null;
  selectedViewUrl = '';
  trustedViewUrl: SafeResourceUrl | null = null;

  uploadFileRef: File | null = null;
  upload = this.defaultUploadMetadata();
  rawTags = 'region=US\npriority=high';

  state: LoadState = 'idle';
  error = '';
  notice = '';
  scanNote = '';

  searchMode: SearchMode = 'short';
  documentQuestion = 'what flags are mentioned in this document?';
  searchFiltersJson = '{}';
  searchTopK = 5;
  shortSearchToken = environment.shortSearchToken;
  searchState: SearchState = 'idle';
  searchError = '';
  searchAnswer = '';
  searchResults: SearchChunkResult[] = [];
  longTaskId = '';
  longTaskStatus = '';
  longTaskPeerCount: number | null = null;
  longTaskSections: LongSearchSection[] = [];
  private longTaskPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly documents: DocumentLibraryService,
    private readonly sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.openFolder(this.folderInput);
  }

  ngOnDestroy(): void {
    this.clearLongTaskPolling();
  }

  defaultUploadMetadata(): UploadMetadata {
    return {
      clientId: this.clientId,
      userId: this.userId,
      fileType: 'contract',
      fileSubType: 'nda',
      docType: 'unstructured',
      stage: 'review',
      bankerId: this.bankerId,
      prospectId: this.prospectId,
      parentFolder: this.folderInput,
      uploadedBy: this.uploadedBy,
      linked: true,
      description: '',
      tags: [
        { key: 'region', value: 'US' },
        { key: 'priority', value: 'high' },
      ],
    };
  }

  openFolder(path: string): void {
    this.currentFolder = this.cleanFolder(path);
    this.folderInput = this.currentFolder;
    this.upload.parentFolder = this.currentFolder;
    this.selectedFile = null;
    this.selectedViewUrl = '';
    this.trustedViewUrl = null;
    this.loadFolder();
  }

  loadFolder(): void {
    if (!this.clientId.trim()) {
      this.error = 'Client ID is required.';
      return;
    }

    this.state = 'loading';
    this.error = '';
    this.notice = '';
    this.scanNote = '';

    this.documents.listFolder({
      clientId: this.clientId.trim(),
      folder: this.currentFolder,
      search: this.search,
      status: this.status,
    }).subscribe({
      next: (response) => {
        this.folders = response.folders;
        this.files = response.files;
        this.breadcrumbs = response.breadcrumbs;
        this.scanNote = response.scanned.note ?? '';
        this.state = 'idle';
      },
      error: (err) => {
        this.error = this.readError(err, 'Could not load the document library.');
        this.state = 'idle';
      },
    });
  }

  refreshContext(): void {
    this.upload.clientId = this.clientId.trim();
    this.upload.userId = this.userId.trim();
    this.upload.uploadedBy = this.uploadedBy.trim();
    this.upload.bankerId = this.bankerId.trim();
    this.upload.prospectId = this.prospectId.trim();
    this.loadFolder();
  }

  createVirtualFolder(): void {
    const name = this.cleanSegment(this.newFolderName);
    if (!name) return;

    const nextPath = this.currentFolder ? `${this.currentFolder}/${name}` : name;
    this.newFolderName = '';
    this.notice = 'Folder path ready. Upload a file here to persist it.';
    this.openFolder(nextPath);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.uploadFileRef = input.files?.[0] ?? null;
    if (!this.upload.description && this.uploadFileRef) {
      this.upload.description = this.uploadFileRef.name;
    }
  }

  uploadSelectedFile(): void {
    if (!this.uploadFileRef) {
      this.error = 'Choose a file before uploading.';
      return;
    }

    this.state = 'uploading';
    this.error = '';
    this.notice = '';

    const metadata: UploadMetadata = {
      ...this.upload,
      clientId: this.clientId.trim(),
      userId: this.userId.trim(),
      bankerId: this.bankerId.trim(),
      prospectId: this.prospectId.trim(),
      uploadedBy: this.uploadedBy.trim(),
      parentFolder: this.cleanFolder(this.upload.parentFolder || this.currentFolder),
      tags: this.parseTags(this.rawTags),
    };

    this.documents.uploadFile(this.uploadFileRef, metadata).subscribe({
      next: (response) => {
        this.notice = `Uploaded ${response.metadata.fileName}`;
        this.uploadFileRef = null;
        this.currentFolder = metadata.parentFolder;
        this.folderInput = metadata.parentFolder;
        this.upload.parentFolder = metadata.parentFolder;
        this.loadFolder();
      },
      error: (err) => {
        this.error = this.readError(err, 'Upload failed.');
        this.state = 'idle';
      },
    });
  }

  viewFile(file: LibraryFile): void {
    this.state = 'viewing';
    this.error = '';
    this.notice = '';
    this.selectedFile = file;
    this.selectedViewUrl = '';
    this.trustedViewUrl = null;

    this.documents.getFile(file.fileId, this.clientId.trim()).subscribe({
      next: (response) => {
        this.selectedFile = response.file;
        this.selectedViewUrl = response.viewUrl;
        this.trustedViewUrl = this.sanitizer.bypassSecurityTrustResourceUrl(response.viewUrl);
        this.state = 'idle';
      },
      error: (err) => {
        this.error = this.readError(err, 'Could not open the file.');
        this.state = 'idle';
      },
    });
  }

  viewSearchResult(fileId: string): void {
    if (!fileId) return;

    const knownFile = this.files.find((file) => file.fileId === fileId);
    if (knownFile) {
      this.viewFile(knownFile);
      return;
    }

    this.viewFile({
      fileId,
      fileName: fileId,
      clientId: this.clientId.trim(),
      userId: '',
      bankerId: '',
      prospectId: '',
      fileType: '',
      fileSubType: '',
      docType: '',
      stage: '',
      uploadedBy: '',
      parentFolder: '',
      description: '',
      tags: [],
      linked: false,
      mimeType: '',
      extension: '',
      fileSize: 0,
      s3Key: '',
      s3Bucket: '',
      uploadStatus: '',
      createdAt: '',
      lastUpdatedAt: '',
    });
  }

  runDocumentSearch(): void {
    if (!this.documentQuestion.trim()) {
      this.searchError = 'Enter a question before searching.';
      return;
    }

    const filters = this.parseJsonObject(this.searchFiltersJson, 'Filters must be valid JSON.');
    if (!filters) return;

    this.clearLongTaskPolling();
    this.searchError = '';
    this.searchAnswer = '';
    this.searchResults = [];
    this.longTaskId = '';
    this.longTaskStatus = '';
    this.longTaskPeerCount = null;
    this.longTaskSections = [];

    if (this.searchMode === 'short') {
      this.runShortSearch(filters);
    } else {
      this.runLongSearch(filters);
    }
  }

  applyCurrentFolderFilter(): void {
    const filters = this.parseJsonObject(this.searchFiltersJson, 'Filters must be valid JSON.');
    if (!filters) return;
    const nextFilters = {
      ...filters,
      clientId: this.clientId.trim(),
      parentFolder: this.currentFolder,
    };
    this.searchFiltersJson = JSON.stringify(nextFilters, null, 2);
  }

  applySelectedFileFilter(): void {
    if (!this.selectedFile) {
      this.searchError = 'Select a file before applying a file filter.';
      return;
    }

    const filters = this.parseJsonObject(this.searchFiltersJson, 'Filters must be valid JSON.');
    if (!filters) return;
    const nextFilters = {
      ...filters,
      fileId: this.selectedFile.fileId,
    };
    this.searchFiltersJson = JSON.stringify(nextFilters, null, 2);
    this.searchError = '';
  }

  canPreviewSelected(): boolean {
    return this.documents.canPreviewInline(this.selectedFile);
  }

  formatBytes(size: number): string {
    if (!size) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return `${(size / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  formatDate(epoch: string): string {
    const value = Number(epoch);
    if (!value) return 'Unknown';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  }

  private parseTags(raw: string): DocumentTag[] {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes('=') ? '=' : ':';
        const [key, ...valueParts] = line.split(separator);
        return {
          key: key.trim(),
          value: valueParts.join(separator).trim(),
        };
      })
      .filter((tag) => tag.key && tag.value);
  }

  private runShortSearch(filters: Record<string, unknown>): void {
    if (!this.shortSearchToken.trim()) {
      this.searchError = 'Short search token is required.';
      return;
    }

    this.searchState = 'searching';
    this.documents.shortSearch({
      query: this.documentQuestion.trim(),
      filters,
      topK: Number(this.searchTopK) || 5,
      token: this.shortSearchToken.trim(),
    }).subscribe({
      next: (response) => {
        this.searchAnswer = response.answer;
        this.searchResults = response.results ?? [];
        this.searchState = 'done';
      },
      error: (err) => {
        this.searchError = this.readError(err, 'Short search failed.');
        this.searchState = 'idle';
      },
    });
  }

  private runLongSearch(variables: Record<string, unknown>): void {
    this.searchState = 'thinking';
    this.documents.startLongSearch({
      query: this.documentQuestion.trim(),
      variables,
    }).subscribe({
      next: (task) => {
        this.longTaskId = task.taskId;
        this.longTaskStatus = task.status;
        this.longTaskPeerCount = task.peerCount ?? null;
        this.pollLongTask(task.pollUrl || task.taskId);
      },
      error: (err) => {
        this.searchError = this.readError(err, 'Could not start thinking search.');
        this.searchState = 'idle';
      },
    });
  }

  private pollLongTask(taskIdOrUrl: string): void {
    this.documents.pollLongSearch(taskIdOrUrl).subscribe({
      next: (task) => {
        this.longTaskId = task.taskId;
        this.longTaskStatus = task.status;
        this.longTaskPeerCount = task.peerCount ?? this.longTaskPeerCount;

        if (task.status === 'done') {
          this.searchAnswer = task.finalAnswer ?? '';
          this.longTaskSections = task.sections ?? [];
          this.searchState = 'done';
          this.clearLongTaskPolling();
          return;
        }

        if (task.status === 'failed') {
          this.searchError = task.error || 'Thinking search failed.';
          this.searchState = 'idle';
          this.clearLongTaskPolling();
          return;
        }

        this.longTaskPollTimer = setTimeout(() => this.pollLongTask(taskIdOrUrl), 1600);
      },
      error: (err) => {
        this.searchError = this.readError(err, 'Could not poll thinking task.');
        this.searchState = 'idle';
        this.clearLongTaskPolling();
      },
    });
  }

  private clearLongTaskPolling(): void {
    if (this.longTaskPollTimer) {
      clearTimeout(this.longTaskPollTimer);
      this.longTaskPollTimer = null;
    }
  }

  private parseJsonObject(raw: string, message: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw || '{}');
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        this.searchError = message;
        return null;
      }
      this.searchError = '';
      return parsed as Record<string, unknown>;
    } catch {
      this.searchError = message;
      return null;
    }
  }

  private cleanFolder(path: string): string {
    return String(path || '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/');
  }

  private cleanSegment(segment: string): string {
    return String(segment || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private readError(err: unknown, fallback: string): string {
    if (typeof err === 'object' && err && 'error' in err) {
      const body = (err as { error?: unknown }).error;
      if (typeof body === 'string' && body.trim()) return body;
      if (typeof body === 'object' && body && 'error' in body) {
        const nested = (body as { error?: unknown }).error;
        if (typeof nested === 'string') return nested;
      }
    }
    return fallback;
  }
}
