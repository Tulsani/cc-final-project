/**
 * Retriever — the REDUCE half of the map/reduce pattern
 *
 * Changes from original:
 *   - queryVectorSearch now handles filters.fileId  (single file restrict)
 *                                   and filters.fileIds (multi-file allowList restrict)
 *   These are used by the P2P peer-nodes to scope each peer's retrieval
 *   to only the files it has been assigned by splitQuery().
 *
 * Everything else is unchanged.
 */

import { getAccessToken, getProjectId } from './gcp-auth.js';

const LOCATION          = process.env.GCP_LOCATION              ?? 'us-central1';
const EMBEDDING_MODEL   = process.env.EMBEDDING_MODEL           ?? 'gemini-embedding-001';
const INDEX_ENDPOINT    = process.env.VECTOR_SEARCH_ENDPOINT;
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
 *   tags?:      string[],
 *   fileId?:    string,    // NEW — scope to a single file (used by P2P peer-nodes)
 *   fileIds?:   string[],  // NEW — scope to multiple files (used by P2P peer-nodes)
 * }
 * @param {number} topK
 * @returns {Promise<Array<{ datapointId, distance }>>}
 */
const queryVectorSearch = async (queryVector, filters, topK = 10) => {
  const token = await getAccessToken();

  const restricts = [];

  // ── Existing restricts (unchanged) ────────────────────────────────────────
  if (filters.clientId) restricts.push({ namespace: 'clientId', allowList: [filters.clientId] });
  if (filters.userId)   restricts.push({ namespace: 'userId',   allowList: [filters.userId] });
  if (filters.fileType) restricts.push({ namespace: 'fileType', allowList: [filters.fileType] });
  if (filters.docType)  restricts.push({ namespace: 'docType',  allowList: [filters.docType] });
  if (filters.stage)    restricts.push({ namespace: 'stage',    allowList: [filters.stage] });
  if (filters.tags?.length) {
    restricts.push({ namespace: 'tag', allowList: filters.tags });
  }

  // ── New: file-level restricts for P2P peer scoping ────────────────────────
  // fileId  = single file  → allowList of one
  // fileIds = many files   → allowList of N (Vector Search ORs within a namespace)
  // Both map to the same 'fileId' namespace that was stored at index time.
  if (filters.fileId) {
    restricts.push({ namespace: 'fileId', allowList: [filters.fileId] });
  } else if (filters.fileIds?.length) {
    restricts.push({ namespace: 'fileId', allowList: filters.fileIds });
  }

  const publicEndpoint = process.env.VECTOR_SEARCH_PUBLIC_ENDPOINT;
  if (!publicEndpoint) throw new Error('VECTOR_SEARCH_PUBLIC_ENDPOINT env var required for querying');

  const findNeighborsUrl = `https://${publicEndpoint}/v1/${INDEX_ENDPOINT}:findNeighbors`;
  console.info('Calling Vector Search', {
    url: findNeighborsUrl,
    deployedIndexId: DEPLOYED_INDEX_ID,
    restrictCount: restricts.length,
    topK,
  });

  const res = await fetch(findNeighborsUrl, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deployedIndexId: DEPLOYED_INDEX_ID,
      queries: [{
        datapoint: {
          datapointId:   'query',
          featureVector: queryVector,
          restricts,
        },
        neighborCount: topK,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Vector Search query failed: ${res.status} ${await res.text()}`);

  const data      = await res.json();
  const neighbors = data.nearestNeighbors?.[0]?.neighbors ?? [];

  return neighbors.map(n => ({
    datapointId: n.datapoint.datapointId,
    distance:    n.distance,
  }));
};

// ─── Firestore batch fetch ────────────────────────────────────────────────────

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

  const docMap = new Map();
  for (const result of results) {
    if (result.found) {
      const rawId = result.found.name.split('/').pop();
      const id    = decodeURIComponent(rawId);
      const doc   = fromFirestoreFields(result.found.fields);
      docMap.set(id, doc);
      console.info('Firestore doc found', { id });
    } else if (result.missing) {
      console.warn('Firestore doc missing', { name: result.missing });
    }
  }

  return datapointIds.map(id => docMap.get(id) ?? null);
};

// ─── Firestore deserialiser (unchanged) ──────────────────────────────────────

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

// ─── Public API (unchanged) ───────────────────────────────────────────────────

export const retrieve = async (queryText, filters = {}, topK = 10) => {
  console.info('retrieve called', { queryText: queryText.slice(0, 80), filters, topK });

  let queryVector;
  try {
    queryVector = await embedQuery(queryText);
    console.info('Query embedded successfully', { dims: queryVector.length });
  } catch (err) {
    console.error('embedQuery failed', err.message, err.stack);
    throw err;
  }

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

  const datapointIds = neighbors.map(n => n.datapointId);
  const metadata     = await fetchFirestoreMetadata(datapointIds);

  return neighbors
    .map((n, i) => ({
      datapointId: n.datapointId,
      score:       n.distance,
      rank:        i + 1,
      ...metadata[i],
    }))
    .filter(r => r.text);
};