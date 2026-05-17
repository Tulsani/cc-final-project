import { getAccessToken, getProjectId } from './gcp-auth.js';

const COLLECTION = process.env.FIRESTORE_COLLECTION ?? 'chunk-metadata';

//  Firestore value serialiser 

const toValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (typeof v === 'number')         return { doubleValue: v };
  if (typeof v === 'string')         return { stringValue: v };
  if (Array.isArray(v))              return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object')         return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
};

const toFields = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, v]) => [k, toValue(v)])
);

//  Write 


export const writeMetadata = async (datapointId, metadata) => {
  const token     = await getAccessToken();
  const projectId = await getProjectId();

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${COLLECTION}/${encodeURIComponent(datapointId)}`;

  const res = await fetch(url, {
    method:  'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFields({ ...metadata, embeddedAt: new Date().toISOString() }),
    }),
  });

  if (!res.ok) throw new Error(`Firestore write failed: ${res.status} ${await res.text()}`);
};