import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MIME_TO_EXTENSION, DEFAULT_PRESIGN_EXPIRY_SECONDS } from './types.js';

const s3Client = new S3Client({});

const BUCKET      = process.env.UPLOAD_BUCKET;
const EXPIRY_SECS = parseInt(process.env.PRESIGN_EXPIRY_SECONDS ?? String(DEFAULT_PRESIGN_EXPIRY_SECONDS), 10);

if (!BUCKET) throw new Error('UPLOAD_BUCKET environment variable is required');

//  S3 key strategy 
// Pattern: {clientId}/{parentFolder?}/{fileId}.{ext}
//
// Keeping clientId as the top-level prefix means:
//   - IAM prefix conditions give cheap per-client isolation
//   - S3 inventory / cost allocation stays clean
//   - Downstream triggers can filter by clientId prefix

export const buildS3Key = (fileId, metadata, ext) => {
  const parts = [metadata.clientId];
  if (metadata.parentFolder) {
    // strip leading/trailing slashes so we never get double-slashes
    parts.push(metadata.parentFolder.replace(/^\/+|\/+$/g, ''));
  }
  parts.push(`${fileId}.${ext}`);
  return parts.join('/');
};

//  S3 object metadata 
// The AWS SDK's PutObjectCommand.Metadata field accepts plain key names —
// the SDK automatically prepends x-amz-meta- when sending to S3.
// Do NOT include the x-amz-meta- prefix here; doing so produces the
// double-prefixed header x-amz-meta-x-amz-meta-* which breaks the signature.

const buildS3ObjectMetadata = (fileId, metadata) => ({
  'file-id':       fileId,
  'client-id':     metadata.clientId,
  'user-id':       metadata.userId,
  'banker-id':     metadata.bankerId     ?? '',
  'prospect-id':   metadata.prospectId   ?? '',
  'file-type':     metadata.fileType,
  'file-sub-type': metadata.fileSubType  ?? '',
  'doc-type':      metadata.docType      ?? '',
  'stage':         metadata.stage        ?? '',
  'parent-folder': metadata.parentFolder ?? '',
  'uploaded-by':   metadata.uploadedBy   ?? '',
  'linked':        String(metadata.linked ?? false),
  'tags':          JSON.stringify(metadata.tags ?? []),
  'description':   metadata.description  ?? '',
});

//  Presigned URL generator 

/**
 * Generates a presigned S3 PUT URL.
 *
 * @param {string} fileId
 * @param {string} contentType  - validated MIME type
 * @param {number} fileSizeBytes
 * @param {object} metadata     - parsed FileUploadMetadata
 * @returns {Promise<{ uploadUrl: string, s3Key: string, expiresIn: number }>}
 */
export const generatePresignedPutUrl = async (fileId, contentType, fileSizeBytes, metadata) => {
  const ext   = MIME_TO_EXTENSION[contentType];
  const s3Key = buildS3Key(fileId, metadata, ext);

  // NOTE: ServerSideEncryption is intentionally omitted here.
  // Including it adds x-amz-server-side-encryption to the presigned URL's signed
  // headers, which means the client PUT must also send that header exactly —
  // Postman and most HTTP clients won't, causing SignatureDoesNotMatch.
  // Enforce encryption at the bucket policy level instead (deny PutObject unless
  // s3:x-amz-server-side-encryption = aws:kms).
  // ContentLength is intentionally excluded from PutObjectCommand.
  // Including it adds content-length to X-Amz-SignedHeaders, which forces the
  // client to send that header with the exact same value. Postman and browsers
  // manage content-length themselves and may not match, causing SignatureDoesNotMatch.
  // Size validation is already done in the Lambda before we reach this point.
  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         s3Key,
    ContentType: contentType,
    Metadata:    buildS3ObjectMetadata(fileId, metadata),
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: EXPIRY_SECS });

  return { uploadUrl, s3Key, expiresIn: EXPIRY_SECS };
};