import { ENV } from './constants.js';

export const chunkText = (rawText, chunkSize = ENV.CHUNK_SIZE_WORDS, overlapWords = ENV.CHUNK_OVERLAP_WORDS) => {
  if (!rawText || rawText.trim().length === 0) return [];

  // Normalise whitespace — Textract occasionally emits double-spaces and newlines
  const words = rawText.trim().replace(/\s+/g, ' ').split(' ');

  if (words.length === 0) return [];

  const chunks  = [];
  const step    = chunkSize - overlapWords; // advance by this many words each iteration
  let   start   = 0;

  while (start < words.length) {
    const end        = Math.min(start + chunkSize, words.length);
    const chunkWords = words.slice(start, end);
    const text       = chunkWords.join(' ');

    chunks.push({
      chunkIndex: chunks.length,
      text,
      wordCount:  chunkWords.length,
      startWord:  start,
      endWord:    end - 1,
    });

    if (end >= words.length) break;
    start += step;
  }

  return chunks;
};

/**
 * Extracts clean plain text from Textract Blocks array.
 * Filters to LINE blocks (not WORD) to preserve natural reading order
 * and avoid redundant word-level duplication.
 *
 * @param {Array} blocks - Textract Blocks array
 * @returns {string}     - joined plain text
 */
export const extractRawText = (blocks) => {
  return blocks
    .filter(block => block.BlockType === 'LINE')
    .map(block => block.Text ?? '')
    .filter(Boolean)
    .join(' ');
};

/**
 * Extracts key-value form pairs from Textract Blocks (FORMS feature).
 * Returns a flat object { "field label": "field value" }.
 *
 * @param {Array} blocks
 * @returns {object}
 */
export const extractFormData = (blocks) => {
  const blockMap = new Map(blocks.map(b => [b.Id, b]));
  const formData = {};

  const keyBlocks = blocks.filter(b => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes?.includes('KEY'));

  for (const keyBlock of keyBlocks) {
    const keyText   = getTextFromRelationships(keyBlock,   blockMap, 'CHILD');
    const valueBlock = getLinkedValueBlock(keyBlock, blockMap);
    const valueText  = valueBlock ? getTextFromRelationships(valueBlock, blockMap, 'CHILD') : '';

    if (keyText) {
      formData[keyText.trim()] = valueText.trim();
    }
  }

  return formData;
};



const getTextFromRelationships = (block, blockMap, relationshipType) => {
  const texts = [];
  for (const rel of block.Relationships ?? []) {
    if (rel.Type !== relationshipType) continue;
    for (const id of rel.Ids ?? []) {
      const child = blockMap.get(id);
      if (child?.BlockType === 'WORD') texts.push(child.Text ?? '');
    }
  }
  return texts.join(' ');
};

const getLinkedValueBlock = (keyBlock, blockMap) => {
  for (const rel of keyBlock.Relationships ?? []) {
    if (rel.Type !== 'VALUE') continue;
    for (const id of rel.Ids ?? []) {
      const block = blockMap.get(id);
      if (block?.EntityTypes?.includes('VALUE')) return block;
    }
  }
  return null;
};