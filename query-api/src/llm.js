/**
 * LLM — Vertex AI Gemini
 *
 * Takes retrieved chunks + original query, builds a prompt,
 * calls Gemini and returns a grounded natural language answer.
 */

import { getAccessToken, getProjectId } from './gcp-auth.js';

const LOCATION = process.env.GCP_LOCATION  ?? 'us-central1';
const LLM_MODEL = process.env.LLM_MODEL   ?? 'gemini-2.5-flash-lite';

/**
 * Generates a grounded answer from retrieved chunks.
 *
 * @param {string} query      - original user question
 * @param {Array}  chunks     - retrieved chunks from Vector Search + Firestore
 * @returns {Promise<string>} - LLM generated answer
 */
export const generateAnswer = async (query, chunks) => {
  const token     = await getAccessToken();
  const projectId = await getProjectId();

  // Build context from chunks — numbered so LLM can cite them
  const context = chunks
    .map((c, i) => `[Chunk ${i + 1} | File: ${c.sourceS3Key?.split('/').pop() ?? c.fileId} | Score: ${c.score?.toFixed(3)}]\n${c.text}`)
    .join('\n\n---\n\n');

  const prompt = `You are a helpful assistant answering questions based strictly on the provided document excerpts.

DOCUMENT EXCERPTS:
${context}

QUESTION: ${query}

Instructions:
- Answer based only on the document excerpts above
- If the answer is not in the excerpts, say "I couldn't find that information in the provided documents"
- Be concise and direct
- Reference which chunk(s) your answer comes from where relevant

ANSWER:`;

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${LLM_MODEL}:generateContent`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.2,   // low temp = factual, grounded answers
        maxOutputTokens: 1024,
        topP:            0.8,
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini call failed: ${res.status} ${await res.text()}`);

  const data   = await res.json();
  const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No answer generated';
  return answer.trim();
};