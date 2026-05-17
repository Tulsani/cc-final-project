import { DynamoDBClient, GetItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddbClient = new DynamoDBClient({});
const s3Client = new S3Client({});

const TABLE = process.env.DOCUMENTS_TABLE;
const DEFAULT_BUCKET = process.env.UPLOAD_BUCKET;
const VIEW_URL_EXPIRES_SECONDS = parseInt(process.env.VIEW_URL_EXPIRES_SECONDS ?? '900', 10);
const MAX_SCAN_PAGES = parseInt(process.env.MAX_SCAN_PAGES ?? '8', 10);

if (!TABLE) throw new Error('DOCUMENTS_TABLE environment variable is required');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const ok = (body) => respond(200, body);
const badReq = (message) => respond(400, { error: message });
const notFound = (message) => respond(404, { error: message });
const internal = (message) => respond(500, { error: message });

const normaliseFolder = (folder = '') =>
  String(folder)
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');

const parseBody = (event) => {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
};

const getRequest = (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  if (method === 'GET') {
    return event.queryStringParameters ?? {};
  }

  return parseBody(event);
};

const numberOrZero = (value) => {
  const parsed = parseInt(value ?? '0', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toPublicFile = (item) => ({
  fileId: item.fileId,
  fileName: item.fileName,
  clientId: item.clientId,
  userId: item.userId,
  bankerId: item.bankerId ?? '',
  prospectId: item.prospectId ?? '',
  fileType: item.fileType ?? '',
  fileSubType: item.fileSubType ?? '',
  docType: item.docType ?? '',
  stage: item.stage ?? '',
  uploadedBy: item.uploadedBy ?? '',
  parentFolder: normaliseFolder(item.parentFolder),
  description: item.description ?? '',
  tags: item.tags ?? [],
  linked: item.linked ?? false,
  mimeType: item.mimeType ?? '',
  extension: item.extension ?? '',
  fileSize: numberOrZero(item.fileSize),
  s3Key: item.s3Key,
  s3Bucket: item.s3Bucket ?? DEFAULT_BUCKET,
  uploadStatus: item.uploadStatus ?? '',
  createdAt: item.createdAt ?? '',
  lastUpdatedAt: item.lastUpdatedAt ?? '',
});

const makeBreadcrumbs = (folder) => {
  const parts = normaliseFolder(folder).split('/').filter(Boolean);
  return [
    { name: 'root', path: '' },
    ...parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ];
};

const scanClientDocuments = async ({ clientId, search, status }) => {
  const values = {
    ':clientId': { S: clientId },
  };
  const names = {
    '#clientId': 'clientId',
  };
  const filters = ['#clientId = :clientId'];

  if (search) {
    values[':search'] = { S: search.toLowerCase() };
    names['#searchString'] = 'searchString';
    filters.push('contains(#searchString, :search)');
  }

  if (status) {
    values[':status'] = { S: status };
    names['#uploadStatus'] = 'uploadStatus';
    filters.push('#uploadStatus = :status');
  }

  const items = [];
  let ExclusiveStartKey;
  let pagesScanned = 0;

  do {
    const response = await ddbClient.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: filters.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey,
      })
    );

    items.push(...(response.Items ?? []).map((item) => unmarshall(item)));
    ExclusiveStartKey = response.LastEvaluatedKey;
    pagesScanned += 1;
  } while (ExclusiveStartKey && pagesScanned < MAX_SCAN_PAGES);

  return {
    items,
    hasMore: Boolean(ExclusiveStartKey),
    pagesScanned,
  };
};

const listFolder = async ({ clientId, folder = '', search = '', status = '' }) => {
  if (!clientId) return badReq('clientId is required');

  const currentFolder = normaliseFolder(folder);
  const scan = await scanClientDocuments({
    clientId,
    search: String(search || '').trim(),
    status: String(status || '').trim(),
  });

  const childFolders = new Map();
  const files = [];

  for (const rawItem of scan.items) {
    const item = toPublicFile(rawItem);
    const itemFolder = normaliseFolder(item.parentFolder);

    if (itemFolder === currentFolder) {
      files.push(item);
      continue;
    }

    const relativePath = currentFolder
      ? itemFolder.startsWith(`${currentFolder}/`)
        ? itemFolder.slice(currentFolder.length + 1)
        : ''
      : itemFolder;

    if (!relativePath) continue;

    const folderName = relativePath.split('/')[0];
    const folderPath = currentFolder ? `${currentFolder}/${folderName}` : folderName;

    if (!childFolders.has(folderPath)) {
      childFolders.set(folderPath, {
        name: folderName,
        path: folderPath,
        fileCount: 0,
      });
    }

    childFolders.get(folderPath).fileCount += 1;
  }

  files.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  return ok({
    requestType: 'list-folder',
    clientId,
    currentFolder,
    breadcrumbs: makeBreadcrumbs(currentFolder),
    folders: [...childFolders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files,
    scanned: {
      pages: scan.pagesScanned,
      hasMore: scan.hasMore,
      note: scan.hasMore
        ? 'Results were truncated by MAX_SCAN_PAGES. Add a GSI for production-scale browsing.'
        : undefined,
    },
  });
};

const getFileRecord = async (fileId) => {
  const response = await ddbClient.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: {
        fileId: { S: fileId },
      },
    })
  );

  return response.Item ? unmarshall(response.Item) : null;
};

const getFileMetadata = async ({ fileId, clientId }) => {
  if (!fileId) return badReq('fileId is required');

  const item = await getFileRecord(fileId);
  if (!item) return notFound('File not found');
  if (clientId && item.clientId !== clientId) return notFound('File not found for this client');

  return ok({
    requestType: 'get-file-metadata',
    file: toPublicFile(item),
  });
};

const getFile = async ({ fileId, clientId }) => {
  if (!fileId) return badReq('fileId is required');

  const item = await getFileRecord(fileId);
  if (!item) return notFound('File not found');
  if (clientId && item.clientId !== clientId) return notFound('File not found for this client');

  const file = toPublicFile(item);
  const bucket = file.s3Bucket;
  if (!bucket) return internal('UPLOAD_BUCKET is required when the record does not include s3Bucket');
  if (!file.s3Key) return internal('File record does not include s3Key');

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: file.s3Key,
    ResponseContentType: file.mimeType || undefined,
    ResponseContentDisposition: file.fileName
      ? `inline; filename="${file.fileName.replace(/"/g, '')}"`
      : undefined,
  });

  const viewUrl = await getSignedUrl(s3Client, command, {
    expiresIn: VIEW_URL_EXPIRES_SECONDS,
  });

  return ok({
    requestType: 'get-file',
    file,
    viewUrl,
    expiresIn: VIEW_URL_EXPIRES_SECONDS,
  });
};

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return respond(204, {});

  let req;
  try {
    req = getRequest(event);
  } catch (err) {
    return badReq(err.message);
  }

  const requestType = req.requestType ?? (req.fileId ? 'get-file' : 'list-folder');

  try {
    if (requestType === 'list-folder') return await listFolder(req);
    if (requestType === 'get-file') return await getFile(req);
    if (requestType === 'get-file-metadata') return await getFileMetadata(req);

    return badReq(`Unsupported requestType '${requestType}'`);
  } catch (err) {
    console.error('KRS-docLibrary failed', { requestType, err });
    return internal('Could not process document library request');
  }
};
