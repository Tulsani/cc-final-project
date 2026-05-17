/**
 * Cloud Run — query-api
 *
 * Changes from original:
 *   - Added GET /files route used by Azure P2P peer-nodes to discover
 *     which fileIds exist for a given filter set before splitting a task.
 *     This avoids needing GCP Firestore credentials on the Azure side.
 *
 * All existing routes (/query, /health) and behaviour are unchanged.
 */

import { createServer } from 'node:http';
import { retrieve }     from './retriever.js';
import { generateAnswer } from './llm.js';
import { getAccessToken, getProjectId } from './gcp-auth.js';

const PORT    = parseInt(process.env.PORT ?? '8080', 10);
const API_KEY = process.env.QUERY_API_KEY;

const CHUNK_COLLECTION = process.env.FIRESTORE_COLLECTION ?? 'chunk-metadata';

//  Request helpers (unchanged) 

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end',  () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const isAuthorised = (req) => {
  if (!API_KEY) return true;
  const header = req.headers['authorization'] ?? '';
  return header === `Bearer ${API_KEY}` || header === API_KEY;
};

//  POST /query (unchanged) 

const handleQuery = async (req, res) => {
  if (!isAuthorised(req)) { json(res, 401, { error: 'Unauthorised' }); return; }

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: 'Invalid JSON body' }); return; }

  const { query, filters = {}, topK = 10 } = body;
  if (!query?.trim()) { json(res, 400, { error: '`query` field is required' }); return; }

  const clampedTopK = Math.min(Math.max(parseInt(topK, 10) || 10, 1), 50);
  const generate    = body.generate !== false;
  const start       = Date.now();

  try {
    const results = await retrieve(query, filters, clampedTopK);

    let answer = null;
    if (generate && results.length > 0) {
      try {
        answer = await generateAnswer(query, results);
      } catch (llmErr) {
        console.error('LLM generation failed (non-fatal)', llmErr.message);
      }
    }

    json(res, 200, {
      answer,
      results,
      query,
      filters,
      topK:    clampedTopK,
      took_ms: Date.now() - start,
    });
  } catch (err) {
    console.error('Query failed', { error: err.message, stack: err.stack });
    json(res, 500, { error: 'Query failed', detail: err.message });
  }
};

//  GET /files (NEW) 
/**
 * Called by Azure P2P peer-nodes during task splitting (splitQuery).
 * Returns all distinct fileIds in chunk-metadata that match the given filters.
 * Peers use this list to divide documents evenly — one group per peer —
 * so each peer's /query call retrieves only its assigned files.
 *
 * Query params (at least one required):
 *   clientId, fileType, userId, stage
 *
 * Response:
 * {
 *   fileIds: string[],   // sorted, deduplicated — deterministic so all peers agree on the split
 *   count:   number,
 *   filters: object,
 * }
 *
 * Example:
 *   GET /files?clientId=acme&fileType=contract
 *   → { fileIds: ["acme/q3_001.pdf", "acme/q3_002.pdf", ...], count: 6, filters: {...} }
 */
const handleListFiles = async (req, res) => {
  if (!isAuthorised(req)) { json(res, 401, { error: 'Unauthorised' }); return; }

  const urlObj  = new URL(req.url, `http://localhost`);
  const filters = {};
  for (const key of ['clientId', 'fileType', 'userId', 'stage', 'docType']) {
    const val = urlObj.searchParams.get(key);
    if (val) filters[key] = val;
  }

  if (Object.keys(filters).length === 0) {
    json(res, 400, { error: 'At least one filter param is required (clientId, fileType, userId, stage, docType)' });
    return;
  }

  try {
    const fileIds = await listDistinctFileIds(filters);
    json(res, 200, { fileIds, count: fileIds.length, filters });
  } catch (err) {
    console.error('File listing failed', err.message);
    json(res, 500, { error: 'File listing failed', detail: err.message });
  }
};

/**
 * Runs a Firestore structured query against chunk-metadata,
 * selecting only the fileId field, then deduplicates.
 * Returns a sorted array so the split is deterministic across all callers.
 */
const listDistinctFileIds = async (filters) => {
  const token     = await getAccessToken();
  const projectId = await getProjectId();
  const parent    = `projects/${projectId}/databases/(default)/documents`;

  // Build one fieldFilter per filter key, combine with AND if multiple
  const fieldFilters = Object.entries(filters).map(([field, value]) => ({
    fieldFilter: {
      field: { fieldPath: field },
      op:    'EQUAL',
      value: { stringValue: value },
    },
  }));

  const where = fieldFilters.length === 1
    ? fieldFilters[0]
    : { compositeFilter: { op: 'AND', filters: fieldFilters } };

  const body = {
    structuredQuery: {
      from:   [{ collectionId: CHUNK_COLLECTION }],
      where,
      select: { fields: [{ fieldPath: 'fileId' }] },   // only fetch fileId — cheap
      limit:  1000,
    },
  };

  const res = await fetch(
    `https://firestore.googleapis.com/v1/${parent}:runQuery`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  );

  if (!res.ok) throw new Error(`Firestore runQuery failed: ${res.status} ${await res.text()}`);

  const rows  = await res.json();
  const seen  = new Set();

  for (const row of rows) {
    const fileId = row.document?.fields?.fileId?.stringValue;
    if (fileId) seen.add(fileId);
  }

  // Sort so every peer independently calling this gets the same order,
  // meaning the chunk assignment is deterministic without coordination.
  return [...seen].sort();
};

//  Router 

const router = async (req, res) => {
  const url    = req.url?.split('?')[0];
  const method = req.method;

  if (url === '/health' && method === 'GET') {
    json(res, 200, { status: 'ok' });
    return;
  }

  if (url === '/query' && method === 'POST') {
    await handleQuery(req, res);
    return;
  }

  // NEW — used by Azure P2P peers during task splitting
  if (url === '/files' && method === 'GET') {
    await handleListFiles(req, res);
    return;
  }

  json(res, 404, { error: 'Not found' });
};

//  Server (unchanged) 

const server = createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error('Unhandled error', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.info(`query-api listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => { console.info('query-api shut down'); process.exit(0); });
});