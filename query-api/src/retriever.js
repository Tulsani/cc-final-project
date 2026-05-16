/**
 * Retriever — the REDUCE half of the map/reduce pattern
 *
 * Takes a natural language query + filter params, returns ranked chunks
 * with full metadata ready to be passed to an LLM as context.
 *
 * Flow:
 *   1. Embed the query text (RETRIEVAL_QUERY task type)
 *   2. Query Vector Search with restricts (clientId, userId, tags filtering)
 *   3. Batch-fetch Firestore metadata for returned datapoint IDs
 *   4. Return ranked results with text + metadata
 *
 * The restricts at query time mirror what was stored at index time.
 * Only datapoints whose allowList contains the query's restrict value are returned.
 * This is how we enforce "banker sees only their clients" scoping.
 */

import { getAccessToken, getProjectId } from './gcp-auth.js';

const LOCATION          = process.env.GCP_LOCATION              ?? 'us-central1';
const EMBEDDING_MODEL   = process.env.EMBEDDING_MODEL           ?? 'gemini-embedding-001';
const INDEX_ENDPOINT    = process.env.VECTOR_SEARCH_ENDPOINT;         // full resource name
const DEPLOYED_INDEX_ID = process.env.VECTOR_SEARCH_DEPLOYED_INDEX_ID;
const COLLECTION        = process.env.FIRESTORE_COLLECTION       ?? 'chunk-metadata';

// ─── Embed query ──────────────────────────────────────────────────────────────

const embedQuery = async (queryText) => {
  const token     = await getAccessToken();
  const projectId = await getProjectId();

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances:  [{ content: queryText, taskType: 'RETRIEVAL_QUERY' }],
      parameters: { outputDimensionality: 768 },
    }),
  });

  if (!res.ok) throw new Error(`Embed query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.predictions[0].embeddings.values;
};

// ─── Vector Search query ──────────────────────────────────────────────────────

/**
 * Queries Vector Search with filter restricts.
 *
 * @param {number[]} queryVector
 * @param {object}   filters  {
 *   clientId?:  string,
 *   userId?:    string,
 *   fileType?:  string,
 *   docType?:   string,
 *   stage?:     string,
 *   tags?:      string[]   // ["region:US", "priority:high"]
 * }
 * @param {number} topK  number of results to return
 * @returns {Promise<Array<{ datapointId, distance }>>}
 */
const queryVectorSearch = async (queryVector, filters, topK = 10) => {
  const token = await getAccessToken();

  // Build restrict filters — only add defined fields
  const restricts = [];
  if (filters.clientId) restricts.push({ namespace: 'clientId', allowList: [filters.clientId] });
  if (filters.userId)   restricts.push({ namespace: 'userId',   allowList: [filters.userId] });
  if (filters.fileType) restricts.push({ namespace: 'fileType', allowList: [filters.fileType] });
  if (filters.docType)  restricts.push({ namespace: 'docType',  allowList: [filters.docType] });
  if (filters.stage)    restricts.push({ namespace: 'stage',    allowList: [filters.stage] });
  if (filters.tags?.length) {
    restricts.push({ namespace: 'tag', allowList: filters.tags });
  }

  // Endpoint public domain for querying — different from the index resource
  // Format: {endpointId}-{projectHash}.{location}-{number}.aiplatform.googleapis.com
  // This is provided by GCP when you deploy an index to an endpoint.
  const publicEndpoint = process.env.VECTOR_SEARCH_PUBLIC_ENDPOINT;
  if (!publicEndpoint) throw new Error('VECTOR_SEARCH_PUBLIC_ENDPOINT env var required for querying');

  const findNeighborsUrl = `https://${publicEndpoint}/v1/${INDEX_ENDPOINT}:findNeighbors`;
  console.info('Calling Vector Search', {
    url: findNeighborsUrl,
    deployedIndexId: DEPLOYED_INDEX_ID,
    restrictCount: restricts.length,
    topK,
  });

  const res = await fetch(
    findNeighborsUrl,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deployedIndexId: DEPLOYED_INDEX_ID,
        queries: [{
          datapoint: {
            datapointId: 'query',
            featureVector: queryVector,
            restricts,
          },
          neighborCount: topK,
        }],
      }),
    }
  );

  if (!res.ok) throw new Error(`Vector Search query failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const neighbors = data.nearestNeighbors?.[0]?.neighbors ?? [];

  return neighbors.map(n => ({
    datapointId: n.datapoint.datapointId,
    distance:    n.distance,
  }));
};

// ─── Firestore batch fetch ────────────────────────────────────────────────────

/**
 * Batch-fetches Firestore documents by datapointId.
 * Uses batchGet for efficiency — one HTTP call for all IDs.
 */
const fetchFirestoreMetadata = async (datapointIds) => {
  if (datapointIds.length === 0) return [];

  const token     = await getAccessToken();
  const projectId = await getProjectId();

  console.info('Fetching Firestore docs', { datapointIds });

  const docNames = datapointIds.map(
    id => `projects/${projectId}/databases/(default)/documents/${COLLECTION}/${id}`
  );

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:batchGet`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: docNames }),
    }
  );

  if (!res.ok) throw new Error(`Firestore batchGet failed: ${res.status} ${await res.text()}`);

  const results = await res.json();
  console.info('Firestore batchGet raw result count', { count: results.length });

  // batchGet returns results in arbitrary order — key by document name
  const docMap = new Map();
  for (const result of results) {
    if (result.found) {
      const rawId = result.found.name.split('/').pop();
      // Firestore may return the ID URL-encoded — decode to match our datapointId format
      const id  = decodeURIComponent(rawId);
      const doc = fromFirestoreFields(result.found.fields);
      docMap.set(id, doc);
      console.info('Firestore doc found', { id });
    } else if (result.missing) {
      console.warn('Firestore doc missing', { name: result.missing });
    }
  }

  return datapointIds.map(id => docMap.get(id) ?? null);
};

// ─── Firestore deserialiser ───────────────────────────────────────────────────

const fromValue = (v) => {
  if ('nullValue'    in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('stringValue'  in v) return v.stringValue;
  if ('arrayValue'   in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ('mapValue'     in v) return fromFirestoreFields(v.mapValue.fields ?? {});
  return null;
};

const fromFirestoreFields = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main retrieval function — the REDUCE step.
 *
 * @param {string} queryText   - natural language question
 * @param {object} filters     - { clientId, userId, fileType, docType, stage, tags }
 * @param {number} topK        - number of chunks to return
 * @returns {Promise<Array>}   - ranked chunks with text + full metadata + relevance score
 */
export const retrieve = async (queryText, filters = {}, topK = 10) => {
  console.info('retrieve called', { queryText: queryText.slice(0, 80), filters, topK });

  // Step 1: embed the query (RETRIEVAL_QUERY task type)
  let queryVector;
  try {
    queryVector = await embedQuery(queryText);
    console.info('Query embedded successfully', { dims: queryVector.length });
  } catch (err) {
    console.error('embedQuery failed', err.message, err.stack);
    throw err;
  }

  // Step 2: find nearest neighbours with restrict-based scoping
  let neighbors;
  try {
    neighbors = await queryVectorSearch(queryVector, filters, topK);
    console.info('Vector Search returned', { count: neighbors.length });
  } catch (err) {
    console.error('queryVectorSearch failed', err.message, err.stack);
    throw err;
  }

  if (neighbors.length === 0) {
    console.info('No results from Vector Search', { filters });
    return [];
  }

  // Step 3: batch fetch full metadata from Firestore (text + all fields)
  const datapointIds = neighbors.map(n => n.datapointId);
  const metadata     = await fetchFirestoreMetadata(datapointIds);

  // Step 4: merge distance score with metadata and return ranked results
  return neighbors
    .map((n, i) => ({
      datapointId: n.datapointId,
      score:       n.distance,        // lower = more similar for DOT_PRODUCT
      rank:        i + 1,
      ...metadata[i],
    }))
    .filter(r => r.text);             // drop any Firestore misses
};