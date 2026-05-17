import { getAccessToken, getProjectId } from './gcp-auth.js';

const LOCATION        = process.env.GCP_LOCATION        ?? 'us-central1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL     ?? 'gemini-embedding-001';
const INDEX_NAME      = process.env.VECTOR_SEARCH_INDEX_NAME;   // full resource name

//  Embeddings 

export const embedText = async (text, taskType = 'RETRIEVAL_DOCUMENT') => {
  const token     = await getAccessToken();
  const projectId = await getProjectId();

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  // gemini-embedding-001 uses 'content' + 'taskType' (camelCase, not snake_case)
  // and returns values at predictions[0].embeddings.values same as before
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ content: text, taskType }],
      parameters: { outputDimensionality: 768 },
    }),
  });

  if (!res.ok) throw new Error(`Vertex AI embed failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return data.predictions[0].embeddings.values;
};

//  Vector Search upsert 

/**
 * Upserts a single datapoint into Vertex AI Vector Search.
 *
 * Restricts encode the filterable fields — clientId, userId, tags etc.
 * crowdingTag = fileId prevents one document dominating search results.
 *
 * @param {string}   datapointId
 * @param {number[]} embedding
 * @param {object}   meta  { clientId, userId, fileType, docType, stage, tags, fileId }
 */
// export const upsertVector = async (datapointId, embedding, meta) => {
//   const token = await getAccessToken();

//   const restricts = buildRestricts(meta);

//   const res = await fetch(
//     `https://${LOCATION}-aiplatform.googleapis.com/v1/${INDEX_NAME}:upsertDatapoints`,
//     {
//       method:  'POST',
//       headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         datapoints: [{
//           datapointId,
//           featureVector: embedding,
//           restricts,
//           crowding_tag: meta.fileId,
//         }],
//       }),
//     }
//   );

//   if (!res.ok) throw new Error(`Vector Search upsert failed: ${res.status} ${await res.text()}`);
// };

//  Restrict builder 
// Each restrict = one filterable dimension.
// allowList = values this datapoint satisfies for that namespace.

export const upsertVector = async (datapointId, embedding, meta) => {
  const token = await getAccessToken();
  const restricts = buildRestricts(meta);

  const datapoint = {
    datapointId,
    featureVector: embedding,
    restricts,
  };

  if (meta.fileId) {
    datapoint.crowdingTag = {
      crowdingAttribute: meta.fileId,
    };
  }

  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/${INDEX_NAME}:upsertDatapoints`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        datapoints: [datapoint],
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Vector Search upsert failed: ${res.status} ${await res.text()}`);
  }
};

const buildRestricts = (meta) => {
  const r = [];

  if (meta.clientId) r.push({ namespace: 'clientId', allowList: [meta.clientId] });
  if (meta.userId)   r.push({ namespace: 'userId',   allowList: [meta.userId] });
  if (meta.fileType) r.push({ namespace: 'fileType', allowList: [meta.fileType] });
  if (meta.docType)  r.push({ namespace: 'docType',  allowList: [meta.docType] });
  if (meta.stage)    r.push({ namespace: 'stage',    allowList: [meta.stage] });

  // Tags as "key:value" strings — each tag is independently filterable
  if (Array.isArray(meta.tags) && meta.tags.length > 0) {
    r.push({
      namespace: 'tag',
      allowList: meta.tags.map(t => `${t.key}:${t.value}`),
    });
  }

  return r;
};