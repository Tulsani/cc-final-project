/**
 * Lambda 1 — textract-trigger
 *
 * Trigger : S3 Event (ObjectCreated)
 * Purpose : Reads the file's S3 object metadata, starts an async Textract
 *           DocumentAnalysis job, and updates DynamoDB status to OCR_STARTED.
 *
 * Textract will publish a completion notification to the configured SNS topic
 * when the job finishes, which triggers Lambda 2 (textract-processor).
 */

import { TextractClient, StartDocumentAnalysisCommand } from '@aws-sdk/client-textract';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ENV, TEXTRACT_JOB_TYPE, UPLOAD_STATUS } from './constants.js';
import { updateFileStatus } from './dynamo.js';

const textract = new TextractClient({ region: ENV.AWS_REGION });
const s3       = new S3Client({});

//  Validation 

const REQUIRED_ENV = ['TEXTRACT_SNS_ROLE_ARN', 'TEXTRACT_SNS_TOPIC_ARN', 'DOCUMENTS_TABLE'];
for (const key of REQUIRED_ENV) {
  if (!ENV[key]) throw new Error(`Missing required environment variable: ${key}`);
}

// Textract only supports these MIME types for async analysis
const TEXTRACT_SUPPORTED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

//  Helpers 

/**
 * Reads x-amz-meta-* headers from the S3 object and returns them as a plain object.
 * These were written by the uploader lambda when generating the presigned URL.
 */
const readS3Metadata = async (bucket, key) => {
  const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  // SDK returns Metadata with keys already stripped of x-amz-meta- prefix, lowercased
  return response.Metadata ?? {};
};

/**
 * Determines which Textract feature types to request based on doc-type metadata.
 * - 'structured'   → TABLES + FORMS  (invoices, bank statements, forms)
 * - 'unstructured' → TABLES only     (contracts, reports — table extraction still useful)
 * - default        → TABLES + FORMS
 */
const resolveFeatureTypes = (docType) => {
  if (docType === 'unstructured') return ['TABLES'];
  return ['TABLES', 'FORMS'];
};

//  Handler 

export const handler = async (event) => {
  console.info('textract-trigger received S3 event', JSON.stringify(event));

  // S3 events can batch multiple records but for ObjectCreated we process each
  const results = await Promise.allSettled(
    event.Records.map(record => processRecord(record))
  );

  // Log any per-record failures without killing the whole batch
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Record[${i}] failed`, result.reason);
    }
  });
};

const processRecord = async (record) => {
  const bucket  = record.s3.bucket.name;
  // S3 key arrives URL-encoded — decode it
  const s3Key   = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const fileSize = record.s3.object.size;

  console.info('Processing S3 object', { bucket, s3Key, fileSize });

  //  1. Read metadata from S3 object head 
  const metadata = await readS3Metadata(bucket, s3Key);
  console.info('S3 object metadata', metadata);

  const fileId   = metadata['file-id'];
  const docType  = metadata['doc-type']  ?? 'unstructured';
  const mimeType = metadata['mime-type'] ?? 'application/pdf'; // fallback — uploader always sets this

  if (!fileId) {
    console.warn('No file-id in S3 metadata, skipping', { s3Key });
    return;
  }

  //  2. Check MIME type is Textract-compatible 
  if (!TEXTRACT_SUPPORTED_TYPES.has(mimeType)) {
    console.info('MIME type not supported by Textract, skipping OCR', { mimeType, fileId });
    // Still mark as uploaded so the record isn't stuck on PENDING
    await updateFileStatus(fileId, UPLOAD_STATUS.UPLOADED, { s3Key, s3Bucket: bucket });
    return;
  }

  //  3. Start async Textract DocumentAnalysis job 
  const featureTypes = resolveFeatureTypes(docType);

  const textractParams = {
    DocumentLocation: {
      S3Object: {
        Bucket: bucket,
        Name:   s3Key,
      },
    },
    FeatureTypes: featureTypes,

    // SNS notification config — Textract calls this topic on job completion
    NotificationChannel: {
      RoleArn:  ENV.TEXTRACT_SNS_ROLE_ARN,
      SNSTopicArn: ENV.TEXTRACT_SNS_TOPIC_ARN,
    },

    // JobTag allows us to correlate the SNS callback back to this file
    // without a DynamoDB lookup — embedded directly in the Textract response
    JobTag: fileId,

    // Pass through key metadata as ClientRequestToken for idempotency
    // (Textract deduplicates jobs with the same token within 24h)
    ClientRequestToken: `${fileId}-${Date.now()}`,
  };

  console.info('Starting Textract job', { fileId, featureTypes, s3Key });

  const textractResponse = await textract.send(
    new StartDocumentAnalysisCommand(textractParams)
  );

  const jobId = textractResponse.JobId;
  console.info('Textract job started', { jobId, fileId });

  //  4. Update DynamoDB — mark as OCR_STARTED 
  await updateFileStatus(fileId, UPLOAD_STATUS.OCR_STARTED, {
    textractJobId:  jobId,
    textractJobType: TEXTRACT_JOB_TYPE.ANALYSIS,
    featureTypes:   featureTypes.join(','),
    s3Key,
    s3Bucket: bucket,
  });

  console.info('DynamoDB updated to OCR_STARTED', { fileId, jobId });
};