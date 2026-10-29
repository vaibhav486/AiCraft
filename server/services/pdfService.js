import fs from 'fs';
import pdf from 'pdf-parse/lib/pdf-parse.js';

// Default configuration with environment overrides
export const PDF_CONFIG = {
  maxFileSizeMB: parseInt(process.env.MAX_PDF_SIZE_MB || '10', 10),
  chunkSize: parseInt(process.env.RAG_CHUNK_SIZE || '600', 10), // approximate tokens
  chunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP || '100', 10), // approximate tokens
};

/**
 * Validates the uploaded file.
 * Checks MIME type, extension, file size, and existence.
 */
export function validatePdfFile(file) {
  if (!file) {
    throw new Error('No file was uploaded.');
  }

  // Check file size
  const maxBytes = PDF_CONFIG.maxFileSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`File size (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${PDF_CONFIG.maxFileSizeMB} MB.`);
  }

  // Check MIME type and extension
  const isPdfMime = file.mimetype === 'application/pdf';
  const hasPdfExt = typeof file.originalname === 'string' && file.originalname.toLowerCase().endsWith('.pdf');

  if (!isPdfMime && !hasPdfExt) {
    throw new Error('Invalid file format. Only PDF files are supported.');
  }

  if (!file.path || !fs.existsSync(file.path)) {
    throw new Error('Uploaded file could not be found on server storage.');
  }
}

/**
 * Safely removes a file from the filesystem.
 */
export function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`[PDF Service] Failed to remove temp file at ${filePath}:`, err.message);
  }
}

/**
 * Extracts text from a PDF buffer page by page, preserving page numbers.
 * @param {Buffer} dataBuffer - Buffer containing PDF data
 * @returns {Promise<{ totalPages: number, pages: Array<{ pageNumber: number, text: string }> }>}
 */
export async function extractPagesFromPdf(dataBuffer) {
  const pages = [];

  const pagerender = async (pageData) => {
    const textContent = await pageData.getTextContent();
    const pageNum = pageData.pageIndex + 1;
    let lastY, text = '';

    for (const item of textContent.items) {
      if (lastY === item.transform[5] || !lastY) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = item.transform[5];
    }

    // Clean whitespace
    const cleanText = text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    pages.push({ pageNumber: pageNum, text: cleanText });
    return cleanText;
  };

  try {
    const result = await pdf(dataBuffer, { pagerender });
    const totalPages = result.numpages || pages.length;

    // Verify there is at least some extractable text across all pages
    const totalTextLength = pages.reduce((sum, p) => sum + p.text.length, 0);
    if (totalTextLength === 0) {
      throw new Error('No extractable text found in this PDF. It may be scanned, image-only, or password-protected.');
    }

    return { totalPages, pages };
  } catch (err) {
    if (err.message?.includes('No extractable text')) {
      throw err;
    }
    throw new Error(`Failed to parse PDF document: ${err.message}`);
  }
}

/**
 * Splits text into chunks respecting approximate token boundaries (~4 chars per token).
 * @param {Array<{ pageNumber: number, text: string }>} pages
 * @param {number} [targetTokens] - Chunk size in tokens (default 600)
 * @param {number} [overlapTokens] - Overlap size in tokens (default 100)
 * @returns {Array<{ chunkText: string, pageNumber: number, chunkIndex: number }>}
 */
export function chunkPages(pages, targetTokens = PDF_CONFIG.chunkSize, overlapTokens = PDF_CONFIG.chunkOverlap) {
  const chunks = [];
  let chunkIndex = 0;

  // Approximate ~4 characters per token
  const targetChars = Math.max(200, targetTokens * 4);
  const overlapChars = Math.max(50, overlapTokens * 4);

  for (const page of pages) {
    const text = page.text;
    if (!text || text.length === 0) continue;

    if (text.length <= targetChars) {
      // Entire page fits in one chunk
      chunks.push({
        chunkText: text,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
      });
      continue;
    }

    // Split page into sentences or paragraphs for more natural chunk boundaries
    let start = 0;
    while (start < text.length) {
      let end = start + targetChars;

      if (end >= text.length) {
        const slice = text.slice(start).trim();
        if (slice.length > 20) {
          chunks.push({
            chunkText: slice,
            pageNumber: page.pageNumber,
            chunkIndex: chunkIndex++,
          });
        }
        break;
      }

      // Try to break at paragraph or sentence boundary
      const searchWindow = text.slice(Math.max(start, end - 150), Math.min(text.length, end + 150));
      const naturalBreak = searchWindow.search(/(\.\s+|\n\n|\n)/);

      let splitPoint = end;
      if (naturalBreak !== -1) {
        splitPoint = Math.max(start, end - 150) + naturalBreak + 1;
      }

      const chunkSlice = text.slice(start, splitPoint).trim();
      if (chunkSlice.length > 20) {
        chunks.push({
          chunkText: chunkSlice,
          pageNumber: page.pageNumber,
          chunkIndex: chunkIndex++,
        });
      }

      // Advance with overlap
      const nextStart = splitPoint - overlapChars;
      if (nextStart <= start) {
        start = splitPoint; // prevent infinite loop if overlap is larger than slice
      } else {
        start = nextStart;
      }
    }
  }

  return chunks;
}
