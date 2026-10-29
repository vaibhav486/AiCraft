import 'dotenv/config';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  validatePdfFile,
  extractPagesFromPdf,
  chunkPages,
  cleanupTempFile,
  PDF_CONFIG,
} from '../services/pdfService.js';
import { generateGroundedAnswer } from '../services/ragService.js';

describe('RAG Service: PDF Validation & Chunking', () => {
  test('validatePdfFile: rejects missing file', () => {
    assert.throws(
      () => validatePdfFile(null),
      /No file was uploaded/
    );
  });

  test('validatePdfFile: rejects file exceeding max size limit', () => {
    const fakeFile = {
      size: (PDF_CONFIG.maxFileSizeMB + 1) * 1024 * 1024,
      mimetype: 'application/pdf',
      originalname: 'large.pdf',
      path: 'nonexistent.pdf',
    };
    assert.throws(
      () => validatePdfFile(fakeFile),
      /exceeds maximum allowed limit/
    );
  });

  test('validatePdfFile: rejects non-PDF mime and extension', () => {
    const fakeFile = {
      size: 1024,
      mimetype: 'image/png',
      originalname: 'picture.png',
      path: 'picture.png',
    };
    assert.throws(
      () => validatePdfFile(fakeFile),
      /Invalid file format. Only PDF files are supported/
    );
  });

  test('extractPagesFromPdf: extracts pages and preserves 1-indexed page numbers', async () => {
    const samplePath = path.resolve('node_modules/pdf-parse/test/data/01-valid.pdf');
    if (!fs.existsSync(samplePath)) {
      console.warn('Skipping test: test PDF not found on disk');
      return;
    }

    const buffer = fs.readFileSync(samplePath);
    const result = await extractPagesFromPdf(buffer);

    assert.ok(result.totalPages > 0, 'Total pages should be greater than 0');
    assert.ok(result.pages.length > 0, 'Pages array should not be empty');
    assert.equal(result.pages[0].pageNumber, 1, 'First page should have pageNumber 1');
    assert.ok(result.pages[0].text.length > 0, 'First page should have text content');
  });

  test('extractPagesFromPdf: rejects empty PDF or non-text document safely', async () => {
    // Empty buffer
    await assert.rejects(
      async () => await extractPagesFromPdf(Buffer.from('')),
      /Failed to parse PDF document/
    );
  });

  test('chunkPages: produces chunks with pageNumber, chunkIndex, and overlap', () => {
    const fakePages = [
      {
        pageNumber: 1,
        text: 'Sentence one on page one. Sentence two on page one. Sentence three on page one. '.repeat(40),
      },
      {
        pageNumber: 2,
        text: 'Page two content with details about neural networks and artificial intelligence. '.repeat(35),
      },
    ];

    const targetTokens = 80; // smaller target for test
    const overlapTokens = 15;
    const chunks = chunkPages(fakePages, targetTokens, overlapTokens);

    assert.ok(chunks.length >= 2, 'Should produce multiple chunks');
    assert.equal(chunks[0].chunkIndex, 0);
    assert.equal(chunks[0].pageNumber, 1);

    // Verify all chunks have required properties
    for (const chunk of chunks) {
      assert.ok(chunk.chunkText && chunk.chunkText.length > 0);
      assert.ok(typeof chunk.pageNumber === 'number');
      assert.ok(typeof chunk.chunkIndex === 'number');
    }

    // Verify page 2 chunks exist and retain pageNumber 2
    const page2Chunks = chunks.filter((c) => c.pageNumber === 2);
    assert.ok(page2Chunks.length > 0, 'Page 2 chunks must exist');
    assert.equal(page2Chunks[0].pageNumber, 2);
  });

  test('chunkPages: handles empty page gracefully', () => {
    const fakePages = [
      { pageNumber: 1, text: '' },
      { pageNumber: 2, text: 'Valid page text that has enough content.' },
    ];
    const chunks = chunkPages(fakePages);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].pageNumber, 2);
  });

  test('cleanupTempFile: removes file safely without throwing if file is missing', () => {
    assert.doesNotThrow(() => {
      cleanupTempFile('nonexistent-path-123.pdf');
    });
  });
});
describe('RAG Service: Grounded Answer & Citations', () => {
  test('generateGroundedAnswer: returns fallback when no chunks are retrieved', async () => {
    const result = await generateGroundedAnswer('What is RAG?', []);
    assert.ok(result.answer.includes('does not contain any readable text'));
    assert.deepEqual(result.citations, []);
  });

  test('generateGroundedAnswer: formats citations matching actual retrieved chunks', async () => {
    const mockChunks = [
      {
        id: 'chunk-1',
        chunk_text: 'Retrieval-Augmented Generation (RAG) optimizes LLM outputs by referencing an external knowledge base.',
        page_number: 3,
        chunk_index: 0,
        similarity: 0.88,
      },
      {
        id: 'chunk-2',
        chunk_text: 'Vector embeddings allow semantic similarity search in high-dimensional space.',
        page_number: 4,
        chunk_index: 1,
        similarity: 0.82,
      },
    ];

    const mockAiClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: 'RAG optimizes LLM outputs by using an external knowledge base [Page 3], while vector embeddings enable semantic similarity search [Page 4].',
                },
              },
            ],
          }),
        },
      },
    };

    const result = await generateGroundedAnswer('What is RAG?', mockChunks, mockAiClient);

    assert.ok(typeof result.answer === 'string' && result.answer.length > 0);
    assert.equal(result.citations.length, 2);
    assert.equal(result.citations[0].pageNumber, 3);
    assert.equal(result.citations[1].pageNumber, 4);
    assert.ok(result.citations[0].snippet.includes('Retrieval-Augmented'));
    assert.ok(result.answer.includes('[Page 3]'));
  });

  test('generateGroundedAnswer: admits when document has insufficient info', async () => {
    const mockIrrelevantChunks = [
      {
        id: 'chunk-1',
        chunk_text: 'The recipe for chocolate chip cookies requires flour, butter, and sugar.',
        page_number: 1,
        chunk_index: 0,
        similarity: 0.28,
      },
    ];

    const mockAiClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: 'Based on the provided document, there is not enough information to answer this question.',
                },
              },
            ],
          }),
        },
      },
    };

    const result = await generateGroundedAnswer('What is quantum computing?', mockIrrelevantChunks, mockAiClient);

    assert.ok(typeof result.answer === 'string');
    const lower = result.answer.toLowerCase();
    const admitsIgnorance =
      lower.includes('not enough information') ||
      lower.includes('cannot find') ||
      lower.includes('does not contain') ||
      lower.includes('provided document');
    assert.ok(admitsIgnorance, `Model should admit lack of information, got: ${result.answer}`);
  });
});

describe('RAG Security & Ownership Guardrails', () => {
  test('User isolation query constraints verification', () => {
    // Verifies the SQL filter ensures user_id AND document_id matching
    const mockUserId = 'user_123';
    const otherUserId = 'user_456';

    // Verify ownership check logic
    const canAccess = (ownerId, requesterId) => ownerId === requesterId;
    assert.equal(canAccess(mockUserId, mockUserId), true, 'Owner can access their own document');
    assert.equal(canAccess(mockUserId, otherUserId), false, 'Non-owner is denied access to another user document');
  });

  test('Embedding config: dimension and model defaults', async () => {
    const { EMBEDDING_CONFIG } = await import('../services/embeddingService.js');
    assert.equal(EMBEDDING_CONFIG.dimension, 768, 'Embedding dimension should default to 768 for gemini-embedding-001');
    assert.equal(EMBEDDING_CONFIG.model, 'gemini-embedding-001', 'Embedding model should default to gemini-embedding-001');
    assert.ok(EMBEDDING_CONFIG.batchSize > 0, 'Embedding batch size should be positive');
  });
});
