import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ddbClient = new DynamoDBClient({});

const TABLE = process.env.DOCUMENTS_TABLE;
if (!TABLE) throw new Error('DOCUMENTS_TABLE environment variable is required');

/**
 * Writes a new file record to DynamoDB with uploadStatus = 'PENDING'.
 * Uses a ConditionExpression to prevent accidental overwrites.
 *
 * @param {object} record - StoredFileRecord
 * @returns {Promise<void>}
 */
export const persistFileRecord = async (record) => {
  await ddbClient.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall(record, { removeUndefinedValues: true }),
      // Guard: fileId is a uuid v4 — collisions should never happen,
      // but this prevents any edge-case overwrite.
      ConditionExpression: 'attribute_not_exists(fileId)',
    })
  );
};