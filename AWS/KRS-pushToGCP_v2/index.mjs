/**
 * Lambda — sqs-pubsub-bridge
 * Auth: GCP Workload Identity Federation (AWS provider)
 *
 * GCP STS requires a subject_token that is a URL-encoded JSON object
 * representing a SIGNED AWS STS GetCallerIdentity request — including
 * the Authorization header with SigV4 signature. GCP replays this
 * request to AWS STS to verify the Lambda's identity.
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createHmac, createHash } from 'node:crypto';

const stsClient = new STSClient({});

//  Config 

const GCP_PROJECT_NUMBER    = process.env.GCP_PROJECT_NUMBER;
const GCP_PROJECT_ID        = process.env.GCP_PROJECT_ID;
const PUBSUB_TOPIC_ID       = process.env.PUBSUB_TOPIC_ID;
const WORKLOAD_POOL_ID      = process.env.WORKLOAD_POOL_ID;
const WORKLOAD_PROVIDER_ID  = process.env.WORKLOAD_PROVIDER_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

for (const [k, v] of Object.entries({
  GCP_PROJECT_NUMBER, GCP_PROJECT_ID, PUBSUB_TOPIC_ID,
  WORKLOAD_POOL_ID, WORKLOAD_PROVIDER_ID, SERVICE_ACCOUNT_EMAIL,
})) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const PUBSUB_URL = `https://pubsub.googleapis.com/v1/projects/${GCP_PROJECT_ID}/topics/${PUBSUB_TOPIC_ID}:publish`;

const AUDIENCE = `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_POOL_ID}/providers/${WORKLOAD_PROVIDER_ID}`;

//  Token cache 

let _cachedToken    = null;
let _tokenExpiresAt = 0;

//  SigV4 helpers 

const sha256hex  = (data) => createHash('sha256').update(data).digest('hex');
const hmac       = (key, data) => createHmac('sha256', key).update(data).digest();
const hmacHex    = (key, data) => createHmac('sha256', key).update(data).digest('hex');

const getSigningKey = (secretKey, dateStamp, region, service) => {
  const kDate    = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
};

/**
 * Builds a SigV4-signed GetCallerIdentity request.
 * GCP STS replays this request to AWS to verify Lambda's identity.
 *
 * Required headers per GCP WIF AWS provider spec:
 *   - host
 *   - x-amz-date
 *   - x-amz-security-token  (required when using temporary credentials / assumed role)
 *   - x-goog-cloud-target-resource  (tells GCP which WIF pool this is for)
 *   - Authorization (SigV4)
 */
const buildSignedStsRequest = () => {
  const accessKeyId     = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken    = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error('Missing AWS runtime credentials');
  }

  const region  = 'us-east-1';
  const service = 'sts';
  const host    = 'sts.amazonaws.com';
  const method  = 'POST';
  const path    = '/';

  // IMPORTANT: for GCP WIF, these must be query params in the signed URL
  const canonicalQueryString = 'Action=GetCallerIdentity&Version=2011-06-15';
  const payload = '';

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host,
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
    'x-goog-cloud-target-resource': AUDIENCE,
  };

  const sortedHeaderKeys  = Object.keys(headers).sort();
  const canonicalHeaders  = sortedHeaderKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaderNames = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    sha256hex(payload),
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature  = hmacHex(signingKey, stringToSign);

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  return encodeURIComponent(JSON.stringify({
    url: `https://${host}${path}?${canonicalQueryString}`,
    method,
    headers: [
      { key: 'Authorization', value: authHeader },
      { key: 'host', value: host },
      { key: 'x-amz-date', value: amzDate },
      { key: 'x-amz-security-token', value: sessionToken },
      { key: 'x-goog-cloud-target-resource', value: AUDIENCE },
    ],
  }));
};

//  GCP token exchange 

const getGcpAccessToken = async () => {
  if (_cachedToken && Date.now() < _tokenExpiresAt) return _cachedToken;

  // Confirm AWS identity (also warms up credentials in the environment)
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  console.info('AWS identity confirmed', { arn: identity.Arn });

  // Step 1 — exchange AWS signed request → GCP federated token
  const subjectToken = buildSignedStsRequest();

  const federatedRes = await fetch('https://sts.googleapis.com/v1/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      audience:             AUDIENCE,
      grant_type:           'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type:   'urn:ietf:params:aws:token-type:aws4_request',
      subject_token:        subjectToken,
      scope:                'https://www.googleapis.com/auth/cloud-platform',
    }),
  });

  if (!federatedRes.ok) {
    throw new Error(`GCP STS exchange failed: ${federatedRes.status} ${await federatedRes.text()}`);
  }

  const federated = await federatedRes.json();
  console.info('GCP federated token obtained');

  // Step 2 — exchange federated token → SA access token
  const saRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${federated.access_token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/pubsub'],
      }),
    }
  );

  if (!saRes.ok) {
    throw new Error(`SA token generation failed: ${saRes.status} ${await saRes.text()}`);
  }

  const saToken   = await saRes.json();
  _cachedToken    = saToken.accessToken;
  _tokenExpiresAt = new Date(saToken.expireTime).getTime() - 5 * 60 * 1000;

  console.info('GCP SA access token obtained via WIF');
  return _cachedToken;
};

//  Handler 

export const handler = async (event) => {
  console.info('sqs-pubsub-bridge invoked', { recordCount: event.Records.length });

  const batchItemFailures = [];
  const pubsubMessages    = [];
  const messageIdMap      = new Map();

  for (const record of event.Records) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch {
      console.error('Failed to parse SQS record body', { messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    messageIdMap.set(pubsubMessages.length, record.messageId);
    pubsubMessages.push({
      data: Buffer.from(record.body).toString('base64'),
      attributes: {
        fileId:       body.fileId       ?? '',
        chunkIndex:   String(body.chunkIndex  ?? ''),
        totalChunks:  String(body.totalChunks ?? ''),
        sqsMessageId: record.messageId,
      },
    });
  }

  if (pubsubMessages.length === 0) {
    console.warn('No valid messages to forward');
    return { batchItemFailures };
  }

  try {
    const token = await getGcpAccessToken();

    const response = await fetch(PUBSUB_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ messages: pubsubMessages }),
    });

    if (!response.ok) {
      throw new Error(`Pub/Sub publish failed: ${response.status} ${await response.text()}`);
    }

    const result = await response.json();
    console.info('Pub/Sub publish complete', {
      forwarded:  pubsubMessages.length,
      messageIds: result.messageIds,
    });

  } catch (err) {
    console.error('Pub/Sub publish error — swallowing while debugging', err.message);
    return {
      batchItemFailures: [],
    };
  }

  return { batchItemFailures };
};