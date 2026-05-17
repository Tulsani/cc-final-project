import { createServer }  from 'node:http';
import { createLibp2p }  from 'libp2p';
import { webSockets }    from '@libp2p/websockets';
import { noise }         from '@chainsafe/libp2p-noise';
import { yamux }         from '@chainsafe/libp2p-yamux';
import { gossipsub }     from '@chainsafe/libp2p-gossipsub';
import { identify }      from '@libp2p/identify';
import { multiaddr }     from '@multiformats/multiaddr';
import { randomBytes }   from 'node:crypto';
import { createHmac }    from 'node:crypto';



const PORT           = parseInt(process.env.PORT          ?? '8080', 10);
const PEER_INDEX     = parseInt(process.env.PEER_INDEX    ?? '0', 10);
const TOTAL_PEERS    = parseInt(process.env.TOTAL_PEERS   ?? '3', 10);
const IS_BOOTSTRAP   = process.env.IS_BOOTSTRAP === 'true';
const BOOTSTRAP_ADDR = process.env.BOOTSTRAP_ADDR ?? null;
const QUERY_API_URL  = process.env.QUERY_API_URL  ?? '';
const QUERY_API_KEY  = process.env.QUERY_API_KEY  ?? '';
const API_KEY        = process.env.PEER_API_KEY   ?? '';

const COSMOS_ENDPOINT  = process.env.COSMOS_ENDPOINT  ?? '';
const COSMOS_DATABASE  = process.env.COSMOS_DATABASE  ?? 'p2p-tasks';
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER ?? 'long-form-task-responses';

// Container Apps injects the IMDS endpoint automatically — no credentials needed.
// The Managed Identity must be assigned "Cosmos DB Built-in Data Contributor" role.

const TOKEN_CACHE = {};

const getAzureToken = async (resource = 'https://cosmos.azure.com') => {
  if (TOKEN_CACHE[resource] && Date.now() < TOKEN_CACHE[resource].exp) {
    return TOKEN_CACHE[resource].token;
  }

  // Azure IMDS endpoint — available inside any Azure compute resource
  const url = `http://169.254.169.254/metadata/identity/oauth2/token` +
    `?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`;

  const res = await fetch(url, { headers: { Metadata: 'true' } });
  if (!res.ok) throw new Error(`Azure IMDS token failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  TOKEN_CACHE[resource] = {
    token: data.access_token,
    exp:   Date.now() + (parseInt(data.expires_in, 10) - 60) * 1000,
  };
  return TOKEN_CACHE[resource].token;
};

// Uses the Cosmos DB REST API with Managed Identity bearer tokens.
// Documents must have an `id` field (Cosmos partition key = id for simplicity).

const cosmosUrl = (docId) => {
  const base = `${COSMOS_ENDPOINT}/dbs/${COSMOS_DATABASE}/colls/${COSMOS_CONTAINER}`;
  return docId ? `${base}/docs/${docId}` : `${base}/docs`;
};

const cosmosWrite = async (doc) => {
  const token = await getAzureToken('https://cosmos.azure.com');
  // Cosmos upsert — creates or replaces the document
  const res = await fetch(cosmosUrl(), {
    method:  'POST',
    headers: {
      'Authorization':     `type=aad,ver=1.0,sig=${token}`,
      'Content-Type':      'application/json',
      'x-ms-date':         new Date().toUTCString(),
      'x-ms-version':      '2018-12-31',
      'x-ms-documentdb-is-upsert': 'true',
      'x-ms-cosmos-allow-tentative-writes': 'true',
    },
    body: JSON.stringify({ id: doc.taskId, ...doc }),
  });

  if (!res.ok) throw new Error(`Cosmos write failed: ${res.status} ${await res.text()}`);
  return res.json();
};

const cosmosRead = async (taskId) => {
  const token = await getAzureToken('https://cosmos.azure.com');
  const res = await fetch(cosmosUrl(taskId), {
    headers: {
      'Authorization': `type=aad,ver=1.0,sig=${token}`,
      'x-ms-date':    new Date().toUTCString(),
      'x-ms-version': '2018-12-31',
      'x-ms-documentdb-partitionkey': `["${taskId}"]`,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cosmos read failed: ${res.status}`);
  return res.json();
};


const splitQuery = (query, filters, totalPeers) =>
  Array.from({ length: totalPeers }, (_, i) => ({
    peerIndex:  i,
    subQuery:   query,
    filters,
    topK:       10,
    focusHint:  `You are summarising section ${i + 1} of ${totalPeers}. Focus only on the document excerpts provided to you.`,
  }));


const callQueryApi = async ({ subQuery, filters, topK, focusHint }) => {
  const res = await fetch(`${QUERY_API_URL}/query`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${QUERY_API_KEY}`,
    },
    body: JSON.stringify({
      query:    `${subQuery}\n\n[${focusHint}]`,
      filters,
      topK,
      generate: true,
    }),
  });
  if (!res.ok) throw new Error(`GCP query-api ${res.status}: ${await res.text()}`);
  return res.json();
};


const synthesise = (query, partials) => {
  const sections = partials
    .sort((a, b) => a.peerIndex - b.peerIndex)
    .map((p, i) => `### Section ${i + 1}\n${p.answer}`)
    .join('\n\n');

  return [
    `# Response to: ${query}`,
    '',
    sections,
    '',
    '---',
    `*Synthesised from ${partials.length} parallel Azure Container App peer nodes via P2P GossipSub*`,
    `*Query answered by GCP Cloud Run query-api (cross-cloud)*`,
  ].join('\n');
};


const p2pPort = PORT + 1000;

const node = await createLibp2p({
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${p2pPort}/ws`] },
  transports:           [webSockets()],
  connectionEncryption: [noise()],
  streamMuxers:         [yamux()],
  services: {
    identify: identify(),
    pubsub:   gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: true }),
  },
});

await node.start();
console.log(`[peer-${PEER_INDEX}] libp2p started peerId=${node.peerId.toString()}`);

if (!IS_BOOTSTRAP && BOOTSTRAP_ADDR) {
  try {
    await node.dial(multiaddr(BOOTSTRAP_ADDR));
    console.log(`[peer-${PEER_INDEX}] dialled bootstrap`);
  } catch (err) {
    console.error(`[peer-${PEER_INDEX}] bootstrap dial failed:`, err.message);
  }
}


const TOPIC = 'p2p-long-form-tasks';
node.services.pubsub.subscribe(TOPIC);

const publish = (msg) =>
  node.services.pubsub.publish(TOPIC, Buffer.from(JSON.stringify(msg)));

// In-memory task state
const activeTasks = new Map();

const getOrCreate = (taskId, query, filters) => {
  if (!activeTasks.has(taskId)) {
    activeTasks.set(taskId, { query, filters, chunks: new Map(), done: false });
  }
  return activeTasks.get(taskId);
};

node.services.pubsub.addEventListener('message', async (evt) => {
  if (evt.detail.topic !== TOPIC) return;

  let msg;
  try { msg = JSON.parse(Buffer.from(evt.detail.data).toString()); }
  catch { return; }

  if (msg.type === 'task-manifest') {
    const { taskId, query, filters, chunks } = msg;
    const myChunk = chunks.find(c => c.peerIndex === PEER_INDEX);
    if (!myChunk) return;

    getOrCreate(taskId, query, filters);
    console.log(`[peer-${PEER_INDEX}] received task ${taskId} — calling GCP query-api`);

    try {
      const result  = await callQueryApi(myChunk);
      const partial = {
        type:        'partial-result',
        taskId,
        peerIndex:   PEER_INDEX,
        answer:      result.answer ?? '(no results)',
        took_ms:     result.took_ms,
        resultCount: result.results?.length ?? 0,
        cloud:       'azure',
      };
      console.log(`[peer-${PEER_INDEX}] answer ready (${result.took_ms}ms) — broadcasting`);
      await publish(partial);
    } catch (err) {
      console.error(`[peer-${PEER_INDEX}] query-api error:`, err.message);
      await publish({
        type: 'partial-result', taskId, peerIndex: PEER_INDEX,
        answer: `[Peer ${PEER_INDEX} error: ${err.message}]`, took_ms: 0, resultCount: 0,
      });
    }
  }

  if (msg.type === 'partial-result') {
    const { taskId, peerIndex, answer, took_ms } = msg;
    const task = activeTasks.get(taskId);
    if (!task || task.done || task.chunks.has(peerIndex)) return;

    console.log(`[peer-${PEER_INDEX}] got partial from peer-${peerIndex} for ${taskId}`);
    task.chunks.set(peerIndex, { peerIndex, answer, took_ms });

    if (task.chunks.size < TOTAL_PEERS) return;

    // All partials in — synthesise and write to Cosmos DB
    task.done = true;
    const partials     = Array.from(task.chunks.values());
    const finalAnswer  = synthesise(task.query, partials);

    console.log(`[peer-${PEER_INDEX}] synthesising final answer for ${taskId}`);

    try {
      await cosmosWrite({
        taskId,
        query:        task.query,
        filters:      task.filters,
        status:       'done',
        finalAnswer,
        peerCount:    TOTAL_PEERS,
        synthesisedBy: `azure-peer-${PEER_INDEX}`,
        completedAt:  new Date().toISOString(),
        infrastructure: {
          peers:    'Azure Container Apps',
          storage:  'Azure Cosmos DB',
          queryApi: 'GCP Cloud Run',
          network:  'libp2p GossipSub',
        },
        sections: partials.map(p => ({
          peerIndex: p.peerIndex,
          answer:    p.answer,
          took_ms:   p.took_ms,
        })),
      });
      console.log(`[peer-${PEER_INDEX}] written to Cosmos DB: ${COSMOS_CONTAINER}/${taskId}`);
    } catch (err) {
      console.error(`[peer-${PEER_INDEX}] Cosmos write failed:`, err.message);
    }

    setTimeout(() => activeTasks.delete(taskId), 60_000);
  }
});


const readBody = (req) => new Promise((res, rej) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end',  () => res(Buffer.concat(chunks).toString()));
  req.on('error', rej);
});

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

const isAuth = (req) => {
  if (!API_KEY) return true;
  const h = req.headers['authorization'] ?? '';
  return h === `Bearer ${API_KEY}` || h === API_KEY;
};


const handlePostTask = async (req, res) => {
  if (!isAuth(req)) { json(res, 401, { error: 'Unauthorised' }); return; }

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: 'Invalid JSON' }); return; }

  const { query, filters = {} } = body;
  if (!query?.trim()) { json(res, 400, { error: '`query` is required' }); return; }

  const taskId = `lft_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const chunks = splitQuery(query, filters, TOTAL_PEERS);

  getOrCreate(taskId, query, filters);

  // Write pending record to Cosmos so caller can poll immediately
  await cosmosWrite({
    taskId, query, filters,
    status:    'pending',
    peerCount: TOTAL_PEERS,
    createdAt: new Date().toISOString(),
    createdBy: `azure-peer-${PEER_INDEX}`,
  }).catch(err => console.warn('Pending Cosmos write failed (non-fatal):', err.message));

  // Broadcast to all peers via GossipSub
  await publish({ type: 'task-manifest', taskId, query, filters, chunks });
  console.log(`[peer-${PEER_INDEX}] submitted task ${taskId}`);

  json(res, 202, {
    taskId,
    status:    'pending',
    peerCount: TOTAL_PEERS,
    pollUrl:   `/task/${taskId}`,
    store:     `Cosmos DB → ${COSMOS_DATABASE}/${COSMOS_CONTAINER}/${taskId}`,
  });
};


const handleGetTask = async (req, res, taskId) => {
  if (!isAuth(req)) { json(res, 401, { error: 'Unauthorised' }); return; }
  try {
    const doc = await cosmosRead(taskId);
    if (!doc) { json(res, 404, { error: 'Task not found' }); return; }
    json(res, 200, doc);
  } catch (err) {
    json(res, 500, { error: 'Failed to read task', detail: err.message });
  }
};


const server = createServer(async (req, res) => {
  try {
    const url = req.url?.split('?')[0] ?? '';

    if (url === '/health' && req.method === 'GET') {
      json(res, 200, {
        status:      'ok',
        peer:        PEER_INDEX,
        peerId:      node.peerId.toString(),
        connectedTo: node.getPeers().length,
        cloud:       'azure',
      });
      return;
    }
    if (url === '/task' && req.method === 'POST') {
      await handlePostTask(req, res); return;
    }
    const m = url.match(/^\/task\/([^/]+)$/);
    if (m && req.method === 'GET') {
      await handleGetTask(req, res, m[1]); return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Unhandled error', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () =>
  console.log(`[peer-${PEER_INDEX}] HTTP on port ${PORT}`)
);

process.on('SIGTERM', async () => {
  await node.stop();
  server.close(() => process.exit(0));
});