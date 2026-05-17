import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, map, switchMap } from 'rxjs';

import { environment } from '../../environments/environment';
import {
  GetFileResponse,
  LibraryFile,
  ListFolderResponse,
  LongSearchTaskResponse,
  LongSearchTaskStart,
  PresignUploadResponse,
  ShortSearchResponse,
  UploadMetadata,
} from '../models/document-library.models';

@Injectable({
  providedIn: 'root',
})
export class DocumentLibraryService {
  constructor(private readonly http: HttpClient) {}

  listFolder(options: {
    clientId: string;
    folder: string;
    search?: string;
    status?: string;
  }): Observable<ListFolderResponse> {
    let params = new HttpParams()
      .set('requestType', 'list-folder')
      .set('clientId', options.clientId)
      .set('folder', options.folder);

    if (options.search?.trim()) params = params.set('search', options.search.trim());
    if (options.status?.trim()) params = params.set('status', options.status.trim());

    return this.http.get<ListFolderResponse>(environment.docLibraryApiUrl, { params });
  }

  getFile(fileId: string, clientId: string): Observable<GetFileResponse> {
    const params = new HttpParams()
      .set('requestType', 'get-file')
      .set('clientId', clientId)
      .set('fileId', fileId);

    return this.http.get<GetFileResponse>(environment.docLibraryApiUrl, { params });
  }

  uploadFile(file: File, metadata: UploadMetadata): Observable<PresignUploadResponse> {
    const headers: Record<string, string> = {
      'content-type': file.type || 'application/octet-stream',
      'x-doc-filename': file.name,
      'x-doc-file-size': String(file.size),
      'x-doc-client-id': metadata.clientId,
      'x-doc-user-id': metadata.userId,
      'x-doc-file-type': metadata.fileType,
      'x-doc-file-sub-type': metadata.fileSubType,
      'x-doc-doc-type': metadata.docType,
      'x-doc-stage': metadata.stage,
      'x-doc-banker-id': metadata.bankerId,
      'x-doc-prospect-id': metadata.prospectId,
      'x-doc-parent-folder': metadata.parentFolder,
      'x-doc-uploaded-by': metadata.uploadedBy,
      'x-doc-linked': String(metadata.linked),
      'x-doc-description': metadata.description,
      'x-doc-tags': JSON.stringify(metadata.tags),
    };

    return this.http.post<PresignUploadResponse>(environment.docUploaderApiUrl, null, { headers }).pipe(
      switchMap((presign) =>
        this.http.put(presign.uploadUrl, file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          responseType: 'text',
        }).pipe(map(() => presign))
      )
    );
  }

  canPreviewInline(file: LibraryFile | null): boolean {
    if (!file) return false;
    return file.mimeType === 'application/pdf' || file.mimeType.startsWith('image/') || file.mimeType.startsWith('text/');
  }

  shortSearch(options: {
    query: string;
    filters: Record<string, unknown>;
    topK: number;
    token: string;
  }): Observable<ShortSearchResponse> {
    return this.http.post<ShortSearchResponse>(
      environment.shortSearchApiUrl,
      {
        query: options.query,
        filters: options.filters,
        topK: options.topK,
      },
      {
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  startLongSearch(options: {
    query: string;
    variables: Record<string, unknown>;
  }): Observable<LongSearchTaskStart> {
    return this.http.post<LongSearchTaskStart>(
      `${environment.longSearchApiBaseUrl}/task`,
      {
        query: options.query,
        variables: options.variables,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  pollLongSearch(taskIdOrUrl: string): Observable<LongSearchTaskResponse> {
    const url = taskIdOrUrl.startsWith('http')
      ? taskIdOrUrl
      : `${environment.longSearchApiBaseUrl}${taskIdOrUrl.startsWith('/') ? '' : '/task/'}${taskIdOrUrl}`;

    return this.http.get<LongSearchTaskResponse>(url);
  }
}
