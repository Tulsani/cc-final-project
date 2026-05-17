

import { createServer } from 'node:http';
import { embedText, upsertVector } from './vertex.js';
import { writeMetadata } from './firestore.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

// AWS S3 credentials for cross-cloud chunk reads
// These come from env vars (injected via Cloud Run secret env or Secret Manager)
const AWS_REGION            = process.env.AWS_REGION          ?? 'us-east-1';
const AWS_ACCESS_KEY_ID     = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_SESSION_TOKEN     = process.env.AWS_SESSION_TOKEN;    // if using temp credentials

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.error('FATAL: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for S3 chunk reads');
  process.exit(1);
}

//  AWS SigV4 S3 fetch 
// We need to sign S3 requests from GCP. No AWS SDK available here —
// implement SigV4 signing using Node.js built-ins.

import { createHmac, createHash } from 'node:crypto';

const hmac   = (key, data)  => createHmac('sha256', key).update(data).digest();
const sha256 = (data)       => createHash('sha256').update(data).digest('hex');

const getSigningKey = (secretKey, dateStamp, region, service) => {
  const kDate    = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
};

/**
 * Fetches an S3 object using AWS SigV4 signed request.
 * No SDK — pure Node.js fetch + crypto.
 */
const fetchFromS3 = async (bucket, key) => {
  const region  = AWS_REGION;
  const service = 's3';
  const host    = `${bucket}.s3.${region}.amazonaws.com`;
  const path    = `/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    'host':                 host,
    'x-amz-date':           amzDate,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    ...(AWS_SESSION_TOKEN ? { 'x-amz-security-token': AWS_SESSION_TOKEN } : {}),
  };

  const signedHeaderNames = Object.keys(headers).sort().join(';');
  const canonicalHeaders  = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}`).join('\n') + '\n';

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequest = [
    'GET', path, '',
    canonicalHeaders,
    signedHeaderNames,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(AWS_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature  = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, {
    headers: { ...headers, 'Authorization': authHeader },
  });

  if (!res.ok) throw new Error(`S3 fetch failed: ${res.status} for s3://${bucket}/${key}`);
  return res.text();
};

//  Request handler 

const handlePubSubPush = async (req, res) => {

  // Health check endpoint — Cloud Run requires this
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // Read request body
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    console.error('Invalid JSON body');
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Pub/Sub push envelope: { message: { data: base64, attributes: {}, messageId }, subscription }
  const pubsubMessage = envelope.message;
  if (!pubsubMessage?.data) {
    console.error('Missing Pub/Sub message data');
    res.writeHead(400);
    res.end('Missing message data');
    return;
  }

  let chunkMsg;
  try {
    chunkMsg = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
  } catch {
    console.error('Failed to decode Pub/Sub message payload');
    // 200 to ACK — malformed messages should not be redelivered forever
    res.writeHead(200);
    res.end();
    return;
  }

  const { fileId, chunkIndex, totalChunks, chunkS3Key, chunksBucket,
          wordCount, startWord, endWord, sourceS3Key, sourceS3Bucket,
          textractJobId } = chunkMsg;

  const attrs = pubsubMessage.attributes ?? {};

  console.info('Processing chunk', { fileId, chunkIndex, totalChunks });

  try {
    //  1. Fetch chunk text from S3 
    const rawChunkJson = await fetchFromS3(chunksBucket, chunkS3Key);
    const chunkObj     = JSON.parse(rawChunkJson);
    const text         = chunkObj.text;

    if (!text?.trim()) {
      console.warn('Empty chunk text, ACKing to avoid infinite retry', { fileId, chunkIndex });
      res.writeHead(200); res.end(); return;
    }

    //  2. Embed the chunk text 
    const embedding = await embedText(text, 'RETRIEVAL_DOCUMENT');

    //  3. Build datapointId — stable, reversible 
    const datapointId = `${fileId}#${String(chunkIndex).padStart(5, '0')}`;

    //  4. Upsert vector into Vertex AI Vector Search 
    const meta = {
      fileId,
      clientId:  attrs.clientId ?? chunkObj.clientId ?? '',
      userId:    chunkObj.userId    ?? '',
      bankerId:  chunkObj.bankerId  ?? '',
      prospectId: chunkObj.prospectId ?? '',
      fileType:  chunkObj.fileType  ?? '',
      docType:   chunkObj.docType   ?? '',
      stage:     chunkObj.stage     ?? '',
      tags:      chunkObj.tags      ?? [],
    };

    await upsertVector(datapointId, embedding, meta);

    //  5. Write full metadata to Firestore 
    await writeMetadata(datapointId, {
      ...meta,
      datapointId,
      chunkIndex,
      totalChunks,
      wordCount,
      startWord,
      endWord,
      chunkS3Key,
      chunksBucket,
      sourceS3Key,
      sourceS3Bucket,
      textractJobId,
      // Store text directly in Firestore — avoids S3 roundtrip at query time
      text,
    });

    console.info('Chunk embedded and indexed', { datapointId, fileId, chunkIndex });

    // HTTP 200 = ACK to Pub/Sub — message is removed from the subscription
    res.writeHead(200);
    res.end('ok');

  } catch (err) {
    console.error('Embedding failed', { fileId, chunkIndex, error: err.message, stack: err.stack });
    // HTTP 500 = NACK — Pub/Sub will redeliver after the ack deadline
    // This is the retry mechanism — no extra logic needed
    res.writeHead(500);
    res.end(err.message);
  }
};

//  Server 

const server = createServer(handlePubSubPush);

server.listen(PORT, () => {
  console.info(`embedder-service listening on port ${PORT}`);
});

// Graceful shutdown — Cloud Run sends SIGTERM before terminating
process.on('SIGTERM', () => {
  console.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.info('Server closed');
    process.exit(0);
  });
});