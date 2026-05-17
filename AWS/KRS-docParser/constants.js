//  Environment 
// Shared by both textract-trigger and textract-processor lambdas.
// Each lambda only uses the subset relevant to it; having them central
// makes cross-referencing the deployment config straightforward.

export const ENV = {
    // Lambda 1 — textract-trigger
    TEXTRACT_SNS_ROLE_ARN:  process.env.TEXTRACT_SNS_ROLE_ARN,   // IAM role Textract assumes to publish to SNS
    TEXTRACT_SNS_TOPIC_ARN: process.env.TEXTRACT_SNS_TOPIC_ARN,  // SNS topic Textract publishes job completion to
    TEXTRACT_FEATURE_TYPES: process.env.TEXTRACT_FEATURE_TYPES ?? 'TABLES,FORMS', // comma-separated
  
    // Lambda 2 — textract-processor
    CHUNKS_BUCKET:          process.env.CHUNKS_BUCKET,            // S3 bucket to store raw text chunks
    EMBEDDING_QUEUE_URL:    process.env.EMBEDDING_QUEUE_URL,      // SQS queue URL for embedder lambda
    DOCUMENTS_TABLE:        process.env.DOCUMENTS_TABLE,          // DynamoDB table (shared with uploader)
  
    // Chunking config
    CHUNK_SIZE_WORDS:       parseInt(process.env.CHUNK_SIZE_WORDS  ?? '400', 10),
    CHUNK_OVERLAP_WORDS:    parseInt(process.env.CHUNK_OVERLAP_WORDS ?? '50', 10),
  
    // AWS region
    AWS_REGION:             process.env.AWS_REGION ?? 'us-east-1',
  };
  
  //  Textract job type 
  // DETECTION  = text only (faster, cheaper)
  // ANALYSIS   = text + forms + tables
  export const TEXTRACT_JOB_TYPE = {
    DETECTION: 'DETECTION',
    ANALYSIS:  'ANALYSIS',
  };
  
  //  DynamoDB uploadStatus values 
  export const UPLOAD_STATUS = {
    PENDING:     'PENDING',
    UPLOADED:    'UPLOADED',
    OCR_STARTED: 'OCR_STARTED',
    OCR_DONE:    'OCR_DONE',
    OCR_FAILED:  'OCR_FAILED',
    CHUNKED:     'CHUNKED',
    EMBEDDED:    'EMBEDDED',
  };