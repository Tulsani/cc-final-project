import { randomUUID } from 'node:crypto';

import { parseRequestFromHeaders, MetadataValidationError } from './metadata.js';
import { generatePresignedPutUrl } from './s3.js';
import { persistFileRecord } from './dynamo.js';
import { MIME_TO_EXTENSION } from './types.js';


const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.CORS_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-doc-client-id,x-doc-user-id,x-doc-banker-id,x-doc-prospect-id,x-doc-file-type,x-doc-file-sub-type,x-doc-doc-type,x-doc-stage,x-doc-parent-folder,x-doc-uploaded-by,x-doc-linked,x-doc-description,x-doc-tags,x-doc-filename,x-doc-file-size',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const ok       = (body)  => respond(200, body);
const badReq   = (msg)   => respond(400, { error: msg });
const internal = (msg)   => respond(500, { error: msg });

// Stored on the DDB record for lightweight filter/contains queries without GSI overhead.

const buildSearchString = (record) =>
  [
    record.fileType,
    record.fileSubType,
    record.docType,
    record.fileName,
    record.stage,
    record.clientId,
    record.prospectId,
    record.bankerId,
    ...(record.tags?.map((t) => `${t.key}:${t.value}`) ?? []),
  ]
    .filter(Boolean)
    .join('-')
    .toLowerCase();

//  Lambda handler 

export const handler = async (event) => {

  // CORS preflight
  if (event.requestContext?.http?.method === 'OPTIONS') return respond(204, {});

  // Normalise headers to lowercase (API Gateway v2 already does this, but be safe)
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? ''])
  );

  //  1. Parse & validate headers 
  let req;
  try {
    req = parseRequestFromHeaders(headers);
  } catch (err) {
    if (err instanceof MetadataValidationError) {
      console.warn('Validation error', { field: err.field, message: err.message });
      return badReq(err.message);
    }
    console.error('Unexpected error during header parsing', err);
    return internal('Invalid request');
  }

  const { filename, contentType, fileSizeBytes, metadata } = req;

  //  2. Generate identifiers 
  const fileId = randomUUID();
  const now    = Date.now().toString();
  const ext    = MIME_TO_EXTENSION[contentType];

  //  3. Generate presigned S3 PUT URL 
  let presign;
  try {
    presign = await generatePresignedPutUrl(fileId, contentType, fileSizeBytes, metadata);
  } catch (err) {
    console.error('Failed to generate presigned URL', { fileId, err });
    return internal('Could not generate upload URL');
  }

  const record = {
    // Keys
    fileId,
    clientId:     metadata.clientId,
    userId:       metadata.userId,


    bankerId:     metadata.bankerId     ?? '',
    prospectId:   metadata.prospectId   ?? '',
    fileType:     metadata.fileType,
    fileSubType:  metadata.fileSubType  ?? '',
    docType:      metadata.docType      ?? '',
    stage:        metadata.stage        ?? '',
    uploadedBy:   metadata.uploadedBy   ?? '',
    parentFolder: metadata.parentFolder ?? '',
    description:  metadata.description  ?? '',
    tags:         metadata.tags         ?? [],
    linked:       metadata.linked       ?? false,


    fileName:     filename,
    mimeType:     contentType,
    extension:    ext,
    fileSize:     fileSizeBytes.toString(),
    s3Key:        presign.s3Key,
    s3Bucket:     process.env.UPLOAD_BUCKET,

    uploadStatus: 'PENDING',

    // Audit
    createdAt:     now,
    lastUpdatedAt: now,
  };


  record.searchString = buildSearchString(record);


  try {
    await persistFileRecord(record);
  } catch (err) {
    console.error('DynamoDB write failed', { fileId, err });
    return internal('Could not register file record');
  }

  
  console.info('Presigned URL issued', {
    fileId,
    clientId:  metadata.clientId,
    userId:    metadata.userId,
    s3Key:     presign.s3Key,
    mimeType:  contentType,
    sizeBytes: fileSizeBytes,
  });

  return ok({
    fileId,
    uploadUrl: presign.uploadUrl,
    s3Key:     presign.s3Key,
    expiresIn: presign.expiresIn,
    metadata:  record,
  });
};