import { SUPPORTED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from './types.js';

//  Header keys 
// All metadata arrives as HTTP headers with the x-doc-* prefix.
// API Gateway forwards them to Lambda in event.headers (lowercased).

const H = {
  CLIENT_ID:     'x-doc-client-id',
  USER_ID:       'x-doc-user-id',
  BANKER_ID:     'x-doc-banker-id',
  PROSPECT_ID:   'x-doc-prospect-id',
  FILE_TYPE:     'x-doc-file-type',
  FILE_SUB_TYPE: 'x-doc-file-sub-type',
  DOC_TYPE:      'x-doc-doc-type',
  STAGE:         'x-doc-stage',
  PARENT_FOLDER: 'x-doc-parent-folder',
  UPLOADED_BY:   'x-doc-uploaded-by',
  LINKED:        'x-doc-linked',
  DESCRIPTION:   'x-doc-description',
  TAGS:          'x-doc-tags',        // JSON-stringified array of { key, value }
  FILENAME:      'x-doc-filename',
  CONTENT_TYPE:  'content-type',
  FILE_SIZE:     'x-doc-file-size',   // file size in bytes as a string
};

//  Helpers 

/** Read a header value, always returns a trimmed string (never undefined). */
const h = (headers, key) => (headers[key] ?? '').trim();

/** Read a required header — throws a descriptive error if missing. */
const requireHeader = (headers, key, fieldName) => {
  const val = h(headers, key);
  if (!val) throw new MetadataValidationError(fieldName, `Header '${key}' is required`);
  return val;
};

/** Strip characters that are unsafe in S3 keys / filenames. */
const sanitiseFilename = (name) => name.replace(/[^a-zA-Z0-9._\-\s]/g, '').trim();

/** Parse and validate the tags JSON header. */
const parseTags = (raw) => {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MetadataValidationError('tags', `x-doc-tags must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new MetadataValidationError('tags', 'x-doc-tags must be a JSON array');
  }
  parsed.forEach((tag, i) => {
    if (typeof tag?.key !== 'string' || typeof tag?.value !== 'string') {
      throw new MetadataValidationError('tags', `tags[${i}] must have string 'key' and 'value' fields`);
    }
  });
  return parsed;
};

//  Custom error 

export class MetadataValidationError extends Error {
  constructor(field, message) {
    super(`[${field}] ${message}`);
    this.name  = 'MetadataValidationError';
    this.field = field;
  }
}

//  Main parser 

/**
 * Parses and validates all request headers into a structured request object.
 *
 * @param {Record<string, string>} headers - Lowercased headers from API Gateway
 * @returns {{ filename, contentType, fileSizeBytes, metadata }}
 */
export const parseRequestFromHeaders = (headers) => {

  // Required fields
  const clientId    = requireHeader(headers, H.CLIENT_ID,    'clientId');
  const userId      = requireHeader(headers, H.USER_ID,      'userId');
  const fileType    = requireHeader(headers, H.FILE_TYPE,    'fileType');
  const rawFilename = requireHeader(headers, H.FILENAME,     'filename');
  const rawCT       = requireHeader(headers, H.CONTENT_TYPE, 'contentType');
  const rawSize     = requireHeader(headers, H.FILE_SIZE,    'fileSizeBytes');

  // MIME validation — strip charset suffix e.g. "application/pdf; charset=utf-8"
  const contentType = rawCT.split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(contentType)) {
    throw new MetadataValidationError(
      'contentType',
      `Unsupported MIME type '${contentType}'. Allowed: ${[...SUPPORTED_MIME_TYPES].join(', ')}`
    );
  }

  // File size validation
  const fileSizeBytes = parseInt(rawSize, 10);
  if (isNaN(fileSizeBytes) || fileSizeBytes <= 0) {
    throw new MetadataValidationError('fileSizeBytes', 'x-doc-file-size must be a positive integer');
  }
  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new MetadataValidationError('fileSizeBytes', 'File exceeds the 500 MB limit');
  }

  // Optional fields
  const metadata = {
    clientId,
    userId,
    fileType,
    bankerId:      h(headers, H.BANKER_ID)     || null,
    prospectId:    h(headers, H.PROSPECT_ID)   || null,
    fileSubType:   h(headers, H.FILE_SUB_TYPE) || null,
    docType:       h(headers, H.DOC_TYPE)      || null,
    stage:         h(headers, H.STAGE)         || null,
    parentFolder:  h(headers, H.PARENT_FOLDER) || null,
    uploadedBy:    h(headers, H.UPLOADED_BY)   || null,
    description:   h(headers, H.DESCRIPTION)   || null,
    linked:        h(headers, H.LINKED) === 'true',
    tags:          parseTags(h(headers, H.TAGS)),
  };

  return {
    filename:    sanitiseFilename(rawFilename),
    contentType,
    fileSizeBytes,
    metadata,
  };
};