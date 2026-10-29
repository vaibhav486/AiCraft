import fs from 'fs';
import path from 'path';
import sql from '../configs/db.js';
import {
  validatePdfFile,
  cleanupTempFile,
  extractPagesFromPdf,
  chunkPages,
} from '../services/pdfService.js';
import { generateBatchEmbeddings } from '../services/embeddingService.js';
import { retrieveRelevantChunks, generateGroundedAnswer } from '../services/ragService.js';

/**
 * Extracts and verifies userId from Clerk auth on request.
 */
function getAuthenticatedUserId(req) {
  let userId = null;
  if (req.auth) {
    if (typeof req.auth === 'function') {
      const authObj = req.auth();
      userId = authObj?.userId;
    } else {
      userId = req.auth.userId;
    }
  }
  if (!userId) {
    const error = new Error('Unauthorized. User authentication required.');
    error.status = 401;
    throw error;
  }
  return userId;
}

/**
 * Sanitizes original filename to prevent path injection or XSS.
 */
function sanitizeFilename(originalName) {
  if (!originalName || typeof originalName !== 'string') return 'document.pdf';
  const base = path.basename(originalName);
  return base.replace(/[^a-zA-Z0-9._\- ]/g, '_').substring(0, 200);
}

/**
 * POST /api/documents/upload
 * Handles PDF upload, validation, parsing, chunking, embedding, and storage.
 */
export async function uploadDocument(req, res) {
  let tempFilePath = req.file?.path;
  let createdDocId = null;

  try {
    const userId = getAuthenticatedUserId(req);

    // 1. Validation
    validatePdfFile(req.file);
    const cleanFilename = sanitizeFilename(req.file.originalname);
    const fileSize = req.file.size;

    // 2. Read file buffer
    const fileBuffer = fs.readFileSync(tempFilePath);

    // 3. Extract text page by page
    const { totalPages, pages } = await extractPagesFromPdf(fileBuffer);

    // 4. Chunk pages
    const chunks = chunkPages(pages);
    if (!chunks || chunks.length === 0) {
      throw new Error('Could not generate text chunks from the document.');
    }

    // 5. Create initial document record with 'processing' status
    const [insertedDoc] = await sql`
      INSERT INTO documents (user_id, filename, file_size, total_pages, total_chunks, status)
      VALUES (${userId}, ${cleanFilename}, ${fileSize}, ${totalPages}, ${chunks.length}, 'processing')
      RETURNING id, filename, total_pages, total_chunks, status, created_at;
    `;
    createdDocId = insertedDoc.id;

    // 6. Generate embeddings for all chunks in batches
    const chunkTexts = chunks.map((c) => c.chunkText);
    const embeddings = await generateBatchEmbeddings(chunkTexts);

    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}.`);
    }

    // 7. Store chunks and embeddings in PostgreSQL
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vectorStr = `[${embeddings[i].join(',')}]`;

      await sql`
        INSERT INTO document_chunks (
          document_id,
          user_id,
          chunk_text,
          page_number,
          chunk_index,
          embedding
        ) VALUES (
          ${createdDocId},
          ${userId},
          ${chunk.chunkText},
          ${chunk.pageNumber},
          ${chunk.chunkIndex},
          ${vectorStr}::vector
        );
      `;
    }

    // 8. Mark document as 'ready'
    const [readyDoc] = await sql`
      UPDATE documents
      SET status = 'ready', updated_at = CURRENT_TIMESTAMP
      WHERE id = ${createdDocId} AND user_id = ${userId}
      RETURNING id, filename, file_size, total_pages, total_chunks, status, created_at;
    `;

    // 9. Clean up uploaded temporary file safely
    cleanupTempFile(tempFilePath);
    tempFilePath = null;

    return res.status(201).json({
      success: true,
      message: 'PDF uploaded and processed successfully.',
      document: readyDoc,
    });
  } catch (error) {
    cleanupTempFile(tempFilePath);

    // If document record was created in DB, update status to failed
    if (createdDocId) {
      try {
        await sql`
          UPDATE documents
          SET status = 'failed', error_message = ${error.message}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${createdDocId};
        `;
      } catch (dbErr) {
        console.error('[Document Controller] Failed to update document status to failed:', dbErr.message);
      }
    }

    const statusCode = error.status || 400;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to process PDF document.',
    });
  }
}

/**
 * GET /api/documents
 * Lists all documents belonging to the authenticated user.
 */
export async function getDocuments(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);

    const documents = await sql`
      SELECT id, filename, file_size, total_pages, total_chunks, status, error_message, created_at, updated_at
      FROM documents
      WHERE user_id = ${userId}
      ORDER BY created_at DESC;
    `;

    return res.json({
      success: true,
      documents,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
}

/**
 * GET /api/documents/:id/status
 * Fetches processing status and metadata for a specific document.
 */
export async function getDocumentStatus(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const [doc] = await sql`
      SELECT id, filename, file_size, total_pages, total_chunks, status, error_message, created_at, updated_at
      FROM documents
      WHERE id = ${id} AND user_id = ${userId};
    `;

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Document not found or unauthorized.',
      });
    }

    return res.json({
      success: true,
      document: doc,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
}

/**
 * GET /api/documents/:id/messages
 * Retrieves conversation history for the document.
 */
export async function getDocumentMessages(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    // Verify ownership
    const [doc] = await sql`
      SELECT id FROM documents WHERE id = ${id} AND user_id = ${userId};
    `;
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found or unauthorized.' });
    }

    const messages = await sql`
      SELECT id, role, content, citations, created_at
      FROM document_chats
      WHERE document_id = ${id} AND user_id = ${userId}
      ORDER BY created_at ASC;
    `;

    return res.json({
      success: true,
      messages,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
}

/**
 * POST /api/documents/:id/chat
 * Asks a question against the document using RAG.
 */
export async function chatWithDocument(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { question } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({
        success: false,
        message: 'A valid question string is required.',
      });
    }

    // Verify document exists and is owned by the user
    const [doc] = await sql`
      SELECT id, filename, status
      FROM documents
      WHERE id = ${id} AND user_id = ${userId};
    `;

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Document not found or access denied.',
      });
    }

    if (doc.status !== 'ready') {
      return res.status(400).json({
        success: false,
        message: `Document is not ready for chat (current status: ${doc.status}).`,
      });
    }

    // 1. Retrieve top-k relevant chunks
    const retrievedChunks = await retrieveRelevantChunks(id, userId, question.trim());

    // 2. Generate grounded answer
    const { answer, citations } = await generateGroundedAnswer(question.trim(), retrievedChunks);

    // 3. Persist user message and assistant response
    await sql`
      INSERT INTO document_chats (document_id, user_id, role, content, citations)
      VALUES (${id}, ${userId}, 'user', ${question.trim()}, '[]'::jsonb);
    `;

    const citationsJson = JSON.stringify(citations || []);
    const [assistantMsg] = await sql`
      INSERT INTO document_chats (document_id, user_id, role, content, citations)
      VALUES (${id}, ${userId}, 'assistant', ${answer}, ${citationsJson}::jsonb)
      RETURNING id, role, content, citations, created_at;
    `;

    return res.json({
      success: true,
      answer,
      citations,
      message: assistantMsg,
    });
  } catch (error) {
    console.error('[Document Controller] Chat error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to generate answer for document.',
    });
  }
}

/**
 * DELETE /api/documents/:id/messages
 * Clears chat history for a document.
 */
export async function clearDocumentMessages(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const [doc] = await sql`
      SELECT id FROM documents WHERE id = ${id} AND user_id = ${userId};
    `;
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found or unauthorized.' });
    }

    await sql`
      DELETE FROM document_chats
      WHERE document_id = ${id} AND user_id = ${userId};
    `;

    return res.json({
      success: true,
      message: 'Chat history cleared successfully.',
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
}

/**
 * DELETE /api/documents/:id
 * Deletes document and its associated chunks and chat history.
 */
export async function deleteDocument(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const [deleted] = await sql`
      DELETE FROM documents
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, filename;
    `;

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Document not found or unauthorized to delete.',
      });
    }

    return res.json({
      success: true,
      message: `Document "${deleted.filename}" and its associated data were deleted successfully.`,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
}
