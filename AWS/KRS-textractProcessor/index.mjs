import { TextractClient, GetDocumentAnalysisCommand } from '@aws-sdk/client-textract';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { ENV, UPLOAD_STATUS } from './constants.js';
import { updateFileStatus } from './dynamo.js';
import { extractRawText, extractFormData, chunkText } from './chunker.js';

const textract = new TextractClient({ region: ENV.AWS_REGION });
const s3       = new S3Client({});
const sqs      = new SQSClient({});

const REQUIRED_ENV = ['CHUNKS_BUCKET', 'EMBEDDING_QUEUE_URL', 'DOCUMENTS_TABLE'];
const missingEnv = REQUIRED_ENV.filter(key => !ENV[key]);
if (missingEnv.length > 0) {
  console.error('FATAL: Missing required environment variables:', missingEnv.join(', '));
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}


export const handler = async (event) => {
  console.info('textract-processor received SNS event', JSON.stringify(event));

  const results = await Promise.allSettled(
    event.Records.map(record => processRecord(record))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Record[${i}] failed with error:`, result.reason?.message ?? result.reason, result.reason?.stack ?? '');
    }
  });
};

const processRecord = async (record) => {
  // SNS wraps the Textract notification inside Message (JSON string)
  const message     = JSON.parse(record.Sns.Message);
  const jobStatus   = message.Status;
  const jobId       = message.JobId;
  // JobTag was set to fileId in the trigger lambda
  const fileId      = message.JobTag;
  const s3Bucket    = message.DocumentLocation?.S3Bucket;
  const s3Key       = message.DocumentLocation?.S3ObjectName;

  console.info('SNS message parsed', { jobId, jobStatus, fileId, s3Key });

  if (!fileId) {
    console.error('JobTag (fileId) missing from Textract SNS message — cannot correlate', { jobId });
    return;
  }

  if (jobStatus !== 'SUCCEEDED') {
    console.error('Textract job did not succeed', { jobId, jobStatus, fileId });
    await updateFileStatus(fileId, UPLOAD_STATUS.OCR_FAILED, {
      textractJobId: jobId,
      ocrFailReason: `Textract job status: ${jobStatus}`,
    });
    return;
  }


  console.info('Paginating Textract results', { jobId, fileId });
  const allBlocks = await paginateTextractResults(jobId);
  console.info('Textract pagination complete', { jobId, blockCount: allBlocks.length });

  // Non-fatal — DDB status update failure should not abort chunking + SQS push
  try {
    await updateFileStatus(fileId, UPLOAD_STATUS.OCR_DONE, {
      textractJobId: jobId,
      blockCount:    allBlocks.length.toString(),
    });
  } catch (ddbErr) {
    console.error('DynamoDB OCR_DONE update failed (non-fatal, continuing):', ddbErr.message, { fileId });
  }


  const rawText  = extractRawText(allBlocks);
  const formData = extractFormData(allBlocks);

  console.info('Text extraction complete', {
    fileId,
    rawTextLength: rawText.length,
    formFieldCount: Object.keys(formData).length,
  });

  if (!rawText || rawText.trim().length === 0) {
    console.warn('No text extracted from document', { fileId, jobId });
    await updateFileStatus(fileId, UPLOAD_STATUS.OCR_FAILED, {
      ocrFailReason: 'No text content extracted from document',
    });
    return;
  }


  const chunks = chunkText(rawText);
  console.info('Chunking complete', { fileId, chunkCount: chunks.length });

  // The SNS message doesn't carry our custom metadata, so we reconstruct the
  // minimum needed from what Textract echoes back (jobTag = fileId) and store
  // the rest in the S3 chunk objects for the embedder to read.
  // Full metadata is also in DynamoDB if the embedder needs more.

  const sqsMessages = [];

  for (const chunk of chunks) {
    const chunkS3Key = buildChunkS3Key(fileId, chunk.chunkIndex);

    // Chunk object stored in S3 — embedder Lambda reads the text from here
    const chunkObject = {
      fileId,
      chunkIndex:  chunk.chunkIndex,
      totalChunks: chunks.length,
      text:        chunk.text,
      wordCount:   chunk.wordCount,
      startWord:   chunk.startWord,
      endWord:     chunk.endWord,
      // Store form data only on chunk 0 to avoid duplication
      formData:    chunk.chunkIndex === 0 ? formData : undefined,
      s3Source: {
        bucket: s3Bucket,
        key:    s3Key,
      },
      createdAt: Date.now().toString(),
    };

    await s3.send(new PutObjectCommand({
      Bucket:      ENV.CHUNKS_BUCKET,
      Key:         chunkS3Key,
      Body:        JSON.stringify(chunkObject),
      ContentType: 'application/json',
      // Tag chunk objects with fileId for lifecycle policies / easy cleanup
      Tagging:     `fileId=${fileId}`,
    }));

    // SQS message — embedder Lambda reads this and fetches text from S3
    sqsMessages.push({
      fileId,
      chunkIndex:   chunk.chunkIndex,
      totalChunks:  chunks.length,
      chunkS3Key,
      chunksBucket: ENV.CHUNKS_BUCKET,
      wordCount:    chunk.wordCount,
      startWord:    chunk.startWord,
      endWord:      chunk.endWord,
      // Source document info — embedder stores these alongside vectors in Vertex AI
      sourceS3Bucket: s3Bucket,
      sourceS3Key:    s3Key,
      textractJobId:  jobId,
    });
  }

  console.info('All chunks written to S3', { fileId, chunkCount: chunks.length });

  await sendSqsMessageBatches(sqsMessages);
  console.info('SQS messages sent', { fileId, messageCount: sqsMessages.length });

  await updateFileStatus(fileId, UPLOAD_STATUS.CHUNKED, {
    chunkCount:       chunks.length.toString(),
    rawTextLength:    rawText.length.toString(),
    formFieldCount:   Object.keys(formData).length.toString(),
    chunksBucket:     ENV.CHUNKS_BUCKET,
    chunksPrefix:     `chunks/${fileId}/`,
  });

  console.info('Processing complete', { fileId, chunks: chunks.length });
};


const paginateTextractResults = async (jobId) => {
  const allBlocks = [];
  let   nextToken = undefined;

  do {
    const params = { JobId: jobId };
    if (nextToken) params.NextToken = nextToken;

    const response = await textract.send(new GetDocumentAnalysisCommand(params));

    if (response.Blocks) {
      allBlocks.push(...response.Blocks);
    }

    nextToken = response.NextToken;

    console.info('Fetched Textract page', {
      jobId,
      blocksFetched: response.Blocks?.length ?? 0,
      hasMore: !!nextToken,
    });

  } while (nextToken);

  return allBlocks;
};

// Pattern: chunks/{fileId}/{chunkIndex}.json
// Prefix per fileId means we can list/delete all chunks for a file in one S3 op

const buildChunkS3Key = (fileId, chunkIndex) =>
  `chunks/${fileId}/${String(chunkIndex).padStart(5, '0')}.json`;

// SQS SendMessageBatch is limited to 10 messages per call

const sendSqsMessageBatches = async (messages) => {
  const BATCH_SIZE = 10;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    const entries = batch.map((msg, idx) => ({
      Id:          `${i + idx}`,   // unique within the batch
      MessageBody: JSON.stringify(msg),
      // MessageGroupId not needed unless using FIFO queue
      // MessageDeduplicationId not needed unless using FIFO queue
    }));

    const response = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: ENV.EMBEDDING_QUEUE_URL,
      Entries:  entries,
    }));

    if (response.Failed?.length > 0) {
      console.error('Some SQS messages failed to send', {
        failed: response.Failed,
        batchStart: i,
      });
      // Don't throw — partial failures are logged; DLQ handles retries
    }
  }
};