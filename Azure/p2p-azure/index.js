/**
 * peer-service — Azure Container Apps (HTTP gossip edition)
 *
 * Replaces libp2p WebSocket transport with direct HTTP calls between peers.
 * Each peer has a stable Container Apps URL — peers fan-out partial results
 * by POST-ing to each other's /internal/partial endpoint directly.
 *
 * This is genuinely P2P: no central broker, peers talk directly to each other.
 *
 * Environment variables:
 *   PEER_INDEX        0 | 1 | 2
 *   TOTAL_PEERS       default 3
 *   PEER_URLS         comma-separated URLs of ALL peers (including self) in index order
 *                     e.g. https://peer-0.xxx.eastus.azurecontainerapps.io,https://peer-1.xxx...,https://peer-2.xxx...
 *   QUERY_API_URL     GCP Cloud Run query-api base URL
 *   QUERY_API_KEY     bearer token for GCP query-api
 *   PEER_API_KEY      optional auth for /task endpoints
 *   COSMOS_ENDPOINT   https://<account>.documents.azure.com:443
 *   COSMOS_DATABASE   default: p2p-tasks
 *   COSMOS_CONTAINER  default: long-form-task-responses
 *   PORT              default: 8080
 */

import { createServer } from 'node:http';
import { randomBytes }  from 'node:crypto';

const PORT           = parseInt(process.env.PORT          ?? '8080', 10);
const PEER_INDEX     = parseInt(process.env.PEER_INDEX    ?? '0', 10);
const TOTAL_PEERS    = parseInt(process.env.TOTAL_PEERS   ?? '3', 10);
const QUERY_API_URL  = process.env.QUERY_API_URL          ?? '';
const QUERY_API_KEY  = process.env.QUERY_API_KEY          ?? '';
const API_KEY        = process.env.PEER_API_KEY           ?? '';
const COSMOS_ENDPOINT  = process.env.COSMOS_ENDPOINT      ?? '';
const COSMOS_DATABASE  = process.env.COSMOS_DATABASE      ?? 'p2p-tasks';
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER     ?? 'long-form-task-responses';
const PEER_URLS = (process.env.PEER_URLS ?? '').split(',').map(u => u.trim()).filter(Boolean);

console.log(`[peer-${PEER_INDEX}] starting  totalPeers=${TOTAL_PEERS}  knownUrls=${PEER_URLS.length}`);

// Cosmos DB — HMAC key auth (simpler than managed identity for Container Apps)
import { createHmac } from 'node:crypto';

const COSMOS_KEY = process.env.COSMOS_KEY ?? '';

const cosmosAuth = (method, resourceType, resourceId, date) => {
  const key    = Buffer.from(COSMOS_KEY, 'base64');
  const text   = `${method.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceId}\n${date.toLowerCase()}\n\n`;
  const sig    = createHmac('sha256', key).update(text).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
};

const cosmosUrl = (docId) => {
  const base = `${COSMOS_ENDPOINT}/dbs/${COSMOS_DATABASE}/colls/${COSMOS_CONTAINER}`;
  return docId ? `${base}/docs/${encodeURIComponent(docId)}` : `${base}/docs`;
};

const cosmosWrite = async (doc) => {
  const date       = new Date().toUTCString();
  const resourceId = `dbs/${COSMOS_DATABASE}/colls/${COSMOS_CONTAINER}`;
  const auth       = cosmosAuth('post', 'docs', resourceId, date);
  const res = await fetch(cosmosUrl(), {
    method: 'POST',
    headers: {
      'Authorization':                      auth,
      'Content-Type':                       'application/json',
      'x-ms-date':                          date,
      'x-ms-version':                       '2018-12-31',
      'x-ms-documentdb-is-upsert':          'true',
      'x-ms-cosmos-allow-tentative-writes': 'true',
      'x-ms-documentdb-partitionkey':       `["${doc.taskId}"]`,
    },
    body: JSON.stringify({ id: doc.taskId, ...doc }),
  });
  if (!res.ok) throw new Error(`Cosmos write failed: ${res.status} ${await res.text()}`);
  return res.json();
};

const cosmosRead = async (taskId) => {
  const date       = new Date().toUTCString();
  const resourceId = `dbs/${COSMOS_DATABASE}/colls/${COSMOS_CONTAINER}/docs/${taskId}`;
  const auth       = cosmosAuth('get', 'docs', resourceId, date);
  const res = await fetch(cosmosUrl(taskId), {
    headers: {
      'Authorization':                 auth,
      'x-ms-date':                     date,
      'x-ms-version':                  '2018-12-31',
      'x-ms-documentdb-partitionkey':  `["${taskId}"]`,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cosmos read failed: ${res.status}`);
  return res.json();
};

// P2P HTTP gossip - broadcast to all other peers directly
const broadcastToPeers = async (endpoint, msg) => {
  const others = PEER_URLS.filter((_, i) => i !== PEER_INDEX);
  await Promise.allSettled(
    others.map(url =>
      fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-peer-key': API_KEY },
        body: JSON.stringify(msg),
      }).then(r => console.log(`[peer-${PEER_INDEX}] → ${url}${endpoint} ${r.status}`))
        .catch(err => console.warn(`[peer-${PEER_INDEX}] → ${url}${endpoint} failed:`, err.message))
    )
  );
};

// File discovery
const fetchFileIds = async (filters) => {
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null));
  const res = await fetch(`${QUERY_API_URL}/files?${params}`, { headers: { 'Authorization': `Bearer ${QUERY_API_KEY}` } });
  if (!res.ok) { console.warn(`[peer-${PEER_INDEX}] /files ${res.status} — offset fallback`); return []; }
  return (await res.json()).fileIds ?? [];
};

// Query splitting
const splitQuery = async (query, filters) => {
  let fileIds = [];
  try { fileIds = await fetchFileIds(filters); } catch {}
  if (fileIds.length > 0) {
    return Array.from({ length: TOTAL_PEERS }, (_, i) => {
      const start = Math.floor((i * fileIds.length) / TOTAL_PEERS);
      const end   = Math.floor(((i + 1) * fileIds.length) / TOTAL_PEERS);
      const myFiles = fileIds.slice(start, end);
      return {
        peerIndex: i, totalChunks: TOTAL_PEERS, subQuery: query,
        filters: myFiles.length === 1 ? { ...filters, fileId: myFiles[0] } : { ...filters, fileIds: myFiles },
        topK: Math.max(8, Math.ceil(30 / TOTAL_PEERS)), strategy: 'file-split', assignedFiles: myFiles,
        focusHint: `Summarise only these documents: ${myFiles.join(', ')}.`,
      };
    });
  }
  const topKPerPeer = 12;
  return Array.from({ length: TOTAL_PEERS }, (_, i) => ({
    peerIndex: i, totalChunks: TOTAL_PEERS, subQuery: query, filters,
    topK: topKPerPeer, strategy: 'offset', assignedFiles: [],
    focusHint: `Answer from document excerpts ranked ${i * topKPerPeer + 1}–${(i + 1) * topKPerPeer}.`,
  }));
};

// Call GCP query-api
const callQueryApi = async ({ subQuery, filters, topK, focusHint }) => {
  const res = await fetch(`${QUERY_API_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QUERY_API_KEY}` },
    body: JSON.stringify({ query: `${subQuery}\n\n[${focusHint}]`, filters, topK, generate: true }),
  });
  if (!res.ok) throw new Error(`GCP query-api ${res.status}: ${await res.text()}`);
  return res.json();
};

// Synthesis
const synthesise = (query, partials) => {
  const sections = [...partials].sort((a, b) => a.peerIndex - b.peerIndex)
    .map((p, i) => `### Section ${i + 1}${p.assignedFiles?.length ? ` — ${p.assignedFiles.join(', ')}` : ''}\n${p.answer}`)
    .join('\n\n');
  return [`# ${query}`, '', sections, '', '---',
    `*Synthesised from ${partials.length} peer nodes via P2P HTTP gossip — Azure Container Apps*`,
    `*Document retrieval: GCP Cloud Run query-api*`].join('\n');
};

// In-memory task state
const activeTasks = new Map();
const getOrCreate = (taskId, query, filters) => {
  if (!activeTasks.has(taskId)) activeTasks.set(taskId, { query, filters, chunks: new Map(), done: false });
  return activeTasks.get(taskId);
};

// Process a chunk — call query-api then broadcast result
const processChunk = async (taskId, myChunk) => {
  console.log(`[peer-${PEER_INDEX}] processing chunk task=${taskId} strategy=${myChunk.strategy}`);
  try {
    const result = await callQueryApi(myChunk);
    const partial = {
      taskId, peerIndex: PEER_INDEX,
      answer: result.answer ?? '(no results)', took_ms: result.took_ms,
      resultCount: result.results?.length ?? 0,
      assignedFiles: myChunk.assignedFiles ?? [], strategy: myChunk.strategy,
    };
    console.log(`[peer-${PEER_INDEX}] chunk done ${result.took_ms}ms — broadcasting`);
    await receivePartial(taskId, partial);
    await broadcastToPeers('/internal/partial', partial);
  } catch (err) {
    console.error(`[peer-${PEER_INDEX}] chunk failed:`, err.message);
    const errPartial = { taskId, peerIndex: PEER_INDEX, answer: `[Peer ${PEER_INDEX} error: ${err.message}]`, took_ms: 0, resultCount: 0, assignedFiles: [], strategy: myChunk.strategy };
    await receivePartial(taskId, errPartial);
    await broadcastToPeers('/internal/partial', errPartial);
  }
};

// Receive a partial result (own or from peer)
const receivePartial = async (taskId, partial) => {
  const task = activeTasks.get(taskId);
  if (!task || task.done || task.chunks.has(partial.peerIndex)) return;
  task.chunks.set(partial.peerIndex, partial);
  console.log(`[peer-${PEER_INDEX}] have ${task.chunks.size}/${TOTAL_PEERS} partials for ${taskId}`);
  if (task.chunks.size < TOTAL_PEERS) return;
  task.done = true;
  const partials = Array.from(task.chunks.values());
  const finalAnswer = synthesise(task.query, partials);
  console.log(`[peer-${PEER_INDEX}] aggregating → Cosmos DB for ${taskId}`);
  try {
    await cosmosWrite({
      taskId, query: task.query, filters: task.filters,
      status: 'done', finalAnswer, peerCount: TOTAL_PEERS,
      synthesisedBy: `azure-peer-${PEER_INDEX}`, completedAt: new Date().toISOString(),
      infrastructure: { peers: 'Azure Container Apps', transport: 'HTTP gossip (P2P)', storage: 'Azure Cosmos DB', queryApi: 'GCP Cloud Run' },
      sections: partials.sort((a, b) => a.peerIndex - b.peerIndex).map(p => ({ peerIndex: p.peerIndex, assignedFiles: p.assignedFiles, answer: p.answer, took_ms: p.took_ms })),
    });
    console.log(`[peer-${PEER_INDEX}] Cosmos DB write done — ${taskId}`);
  } catch (err) {
    console.error(`[peer-${PEER_INDEX}] Cosmos write failed:`, err.message);
  }
  setTimeout(() => activeTasks.delete(taskId), 60_000);
};

// HTTP helpers
const readBody = (req) => new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); req.on('error', rej); });
const json = (res, status, body) => { const p = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }); res.end(p); };
const isAuth = (req) => { if (!API_KEY) return true; const h = req.headers['authorization'] ?? ''; return h === `Bearer ${API_KEY}` || h === API_KEY; };

// POST /task
const handlePostTask = async (req, res) => {
  if (!isAuth(req)) { json(res, 401, { error: 'Unauthorised' }); return; }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
  const { query, filters = {} } = body;
  if (!query?.trim()) { json(res, 400, { error: '`query` is required' }); return; }
  const taskId = `lft_${Date.now()}_${randomBytes(3).toString('hex')}`;
  let chunks;
  try { chunks = await splitQuery(query, filters); } catch (err) { json(res, 500, { error: 'splitQuery failed', detail: err.message }); return; }
  getOrCreate(taskId, query, filters);
  cosmosWrite({ taskId, query, filters, status: 'pending', peerCount: TOTAL_PEERS, createdAt: new Date().toISOString(), createdBy: `azure-peer-${PEER_INDEX}`, strategy: chunks[0]?.strategy })
    .catch(err => console.warn('Pending Cosmos write failed:', err.message));
  await broadcastToPeers('/internal/task', { taskId, query, filters, chunks });
  const myChunk = chunks.find(c => c.peerIndex === PEER_INDEX);
  if (myChunk) processChunk(taskId, myChunk);
  json(res, 202, { taskId, status: 'pending', peerCount: TOTAL_PEERS, strategy: chunks[0]?.strategy, pollUrl: `/task/${taskId}` });
};

// POST /internal/task (from another peer)
const handleInternalTask = async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
  const myChunk = body.chunks?.find(c => c.peerIndex === PEER_INDEX);
  if (!myChunk) { json(res, 200, { skipped: true }); return; }
  getOrCreate(body.taskId, body.query, body.filters);
  json(res, 202, { accepted: true, peerIndex: PEER_INDEX });
  processChunk(body.taskId, myChunk);
};

// POST /internal/partial (from another peer)
const handleInternalPartial = async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
  json(res, 202, { accepted: true });
  if (!activeTasks.has(body.taskId)) activeTasks.set(body.taskId, { query: '', filters: {}, chunks: new Map(), done: false });
  await receivePartial(body.taskId, body);
};

// GET /task/:taskId
const handleGetTask = async (req, res, taskId) => {
  if (!isAuth(req)) { json(res, 401, { error: 'Unauthorised' }); return; }
  try {
    const doc = await cosmosRead(taskId);
    if (!doc) { json(res, 404, { error: 'Task not found' }); return; }
    json(res, 200, doc);
  } catch (err) { json(res, 500, { error: 'Failed to read task', detail: err.message }); }
};

// HTTP server
const server = createServer(async (req, res) => {
  try {
    const url = req.url?.split('?')[0] ?? '';
    const method = req.method;
    if (url === '/health' && method === 'GET') { json(res, 200, { status: 'ok', peer: PEER_INDEX, peerId: `azure-peer-${PEER_INDEX}`, knownPeers: PEER_URLS.length, transport: 'http-gossip', cloud: 'azure' }); return; }
    if (url === '/task' && method === 'POST') { await handlePostTask(req, res); return; }
    if (url === '/internal/task' && method === 'POST') { await handleInternalTask(req, res); return; }
    if (url === '/internal/partial' && method === 'POST') { await handleInternalPartial(req, res); return; }
    const m = url.match(/^\/task\/([^/]+)$/);
    if (m && method === 'GET') { await handleGetTask(req, res, m[1]); return; }
    json(res, 404, { error: 'Not found' });
  } catch (err) { console.error('Unhandled error', err); json(res, 500, { error: 'Internal server error' }); }
});

server.listen(PORT, () => console.log(`[peer-${PEER_INDEX}] HTTP on :${PORT}  peers=${PEER_URLS.join(', ')}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));