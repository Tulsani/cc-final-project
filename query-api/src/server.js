/**
 * Cloud Run — query-api
 *
 * HTTP API for semantic search over embedded documents.
 * This is the REDUCE half — aggregates top-K results from Vector Search
 * across all indexed chunks, scoped by filter restricts.
 *
 * Routes:
 *   POST /query     — semantic search with filters
 *   GET  /health    — health check
 *
 * Designed to run with min-instances=1 so the first query is fast.
 * Auth: expects a Bearer token in Authorization header (validate against
 * your own auth system — JWT, API key, etc.)
 */

import { createServer } from 'node:http';
import { retrieve } from './retriever.js';
import { generateAnswer } from './llm.js';

const PORT       = parseInt(process.env.PORT ?? '8080', 10);
const API_KEY    = process.env.QUERY_API_KEY;   // simple API key auth for the query endpoint

// ─── Request helpers ──────────────────────────────────────────────────────────

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end',  () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

const isAuthorised = (req) => {
  if (!API_KEY) return true;   // no key configured = open (dev only)
  const header = req.headers['authorization'] ?? '';
  return header === `Bearer ${API_KEY}` || header === API_KEY;
};

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /query
 *
 * Request body:
 * {
 *   query:    string,         // natural language question — required
 *   filters: {
 *     clientId?:  string,     // scope to one client
 *     userId?:    string,     // scope to one banker's uploads
 *     fileType?:  string,     // e.g. "contract"
 *     docType?:   string,     // e.g. "unstructured"
 *     stage?:     string,     // e.g. "review"
 *     tags?:      string[],   // e.g. ["region:US", "priority:high"]
 *   },
 *   topK?:    number,         // default 10, max 50
 * }
 *
 * Response:
 * {
 *   results: [
 *     {
 *       rank:        number,
 *       score:       number,
 *       datapointId: string,
 *       text:        string,
 *       fileId:      string,
 *       chunkIndex:  number,
 *       totalChunks: number,
 *       clientId:    string,
 *       userId:      string,
 *       fileType:    string,
 *       tags:        [{ key, value }],
 *       sourceS3Key: string,
 *       embeddedAt:  string,
 *       // ... all Firestore metadata fields
 *     }
 *   ],
 *   query:    string,
 *   filters:  object,
 *   topK:     number,
 *   took_ms:  number,
 * }
 */
const handleQuery = async (req, res) => {
  if (!isAuthorised(req)) {
    json(res, 401, { error: 'Unauthorised' });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { query, filters = {}, topK = 10 } = body;

  if (!query?.trim()) {
    json(res, 400, { error: '`query` field is required' });
    return;
  }

  const clampedTopK = Math.min(Math.max(parseInt(topK, 10) || 10, 1), 50);

  // generate=true triggers LLM answer generation on top of retrieval
  const generate = body.generate !== false;   // default true
  const start    = Date.now();

  try {
    const results = await retrieve(query, filters, clampedTopK);

    let answer = null;
    if (generate && results.length > 0) {
      try {
        answer = await generateAnswer(query, results);
      } catch (llmErr) {
        console.error('LLM generation failed (non-fatal)', llmErr.message);
        answer = null;  // return chunks even if LLM fails
      }
    }

    json(res, 200, {
      answer,           // natural language answer from Gemini (null if generate=false or no results)
      results,          // raw ranked chunks with text + metadata
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

// ─── Router ───────────────────────────────────────────────────────────────────

const router = async (req, res) => {
  const url = req.url?.split('?')[0];

  if (url === '/health' && req.method === 'GET') {
    json(res, 200, { status: 'ok' });
    return;
  }

  if (url === '/query' && req.method === 'POST') {
    await handleQuery(req, res);
    return;
  }

  json(res, 404, { error: 'Not found' });
};

// ─── Server ───────────────────────────────────────────────────────────────────

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