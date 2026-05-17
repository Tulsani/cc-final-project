import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { ENV } from './constants.js';

const ddb = new DynamoDBClient({});

/**
 * Updates the uploadStatus and any extra fields on a file record.
 * Called by both the trigger lambda (OCR_STARTED) and processor lambda (OCR_DONE / CHUNKED).
 *
 * @param {string} fileId
 * @param {string} status         - one of UPLOAD_STATUS constants
 * @param {object} extraFields    - additional top-level fields to set e.g. { textractJobId, chunkCount }
 */
export const updateFileStatus = async (fileId, status, extraFields = {}) => {
  const now = Date.now().toString();

  // Build a dynamic UpdateExpression from extraFields + always-updated audit fields
  const fields = {
    uploadStatus:  status,
    lastUpdatedAt: now,
    ...extraFields,
  };

  const exprParts   = [];
  const attrNames   = {};
  const attrValues  = {};

  for (const [key, value] of Object.entries(fields)) {
    const nameToken  = `#${key}`;
    const valueToken = `:${key}`;
    exprParts.push(`${nameToken} = ${valueToken}`);
    attrNames[nameToken]  = key;
    attrValues[valueToken] = value;
  }

  await ddb.send(new UpdateItemCommand({
    TableName:                 ENV.DOCUMENTS_TABLE,
    Key:                       marshall({ fileId }),
    UpdateExpression:          `SET ${exprParts.join(', ')}`,
    ExpressionAttributeNames:  attrNames,
    ExpressionAttributeValues: marshall(attrValues, { removeUndefinedValues: true }),
  }));
};