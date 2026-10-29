# My-AI: AI SaaS Platform with RAG-Based PDF Chat

My-AI is a full-stack SaaS platform featuring multiple AI content and media creation tools, extended with **Retrieval-Augmented Generation (RAG) for interactive PDF Chat**.

---

## 1. What the RAG Feature Does

The **Chat with PDF** feature allows authenticated users to upload PDF documents, automatically indices their contents using vector embeddings, and enables conversational question answering where every answer is:
- **Grounded strictly in retrieved document excerpts**: Prevents hallucinations and unauthorized extrapolations.
- **Accurately cited with page numbers**: Every reference specifies source page numbers (e.g., `[Page 3]`).
- **Secure and user-isolated**: Users can only query and retrieve their own uploaded documents.
- **Untrusted-content resilient**: Defends against prompt injection embedded within uploaded documents.

---

## 2. High-Level Architecture & Request Flow

```
+-----------------------------------------------------------------------------------------+
|                                    INGESTION PIPELINE                                    |
+-----------------------------------------------------------------------------------------+
  User Uploads PDF
        │
        ▼
  Express Backend (Multer temporary storage + validation)
        │
        ▼
  Page-by-Page Extraction (`pdf-parse` custom pagerender preserving page numbers)
        │
        ▼
  Text Chunking (~600 tokens per chunk with ~100 token overlap & page metadata)
        │
        ▼
  Embedding Generation (Google Gemini `gemini-embedding-001`, 768-dim, batched)
        │
        ▼
  Vector Storage (Neon PostgreSQL with `pgvector` extension + HNSW cosine index)
        │
        ▼
  Temp File Cleanup & Status Updated to 'ready'

+-----------------------------------------------------------------------------------------+
|                                  RETRIEVAL & ANSWER FLOW                                |
+-----------------------------------------------------------------------------------------+
  User asks question in React UI
        │
        ▼
  Clerk JWT Auth verification & Document Ownership check
        │
        ▼
  Question Vector Embedding generated (`gemini-embedding-001`)
        │
        ▼
  Cosine Similarity Search in Neon PostgreSQL (`<=>` operator, top-k chunks)
        │
        ▼
  Prompt Synthesis with Untrusted Content Guardrails + Excerpts + Page Numbers
        │
        ▼
  LLM Generation (`gemini-2.0-flash` with low temperature 0.2)
        │
        ▼
  Response returned with structured, validated source citations and page badges
```

---

## 3. Database Schema & pgvector Setup

The application uses PostgreSQL on Neon. The database schema is managed automatically upon server startup via `server/configs/migrations.js`.

### 1. Enable pgvector
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Documents Table (`documents`)
```sql
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  total_pages INTEGER DEFAULT 0,
  total_chunks INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
```

### 3. Document Chunks Table (`document_chunks`)
```sql
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding vector(768),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user_id ON document_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
```

### 4. Document Chats Table (`document_chats`)
```sql
CREATE TABLE IF NOT EXISTS document_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_document_chats_doc_user ON document_chats(document_id, user_id, created_at ASC);
```

---

## 4. Environment Variables

### Server (`server/.env`)
| Variable | Description | Default / Example |
|---|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string | `postgresql://...@neon.tech/neondb?sslmode=require` |
| `CLERK_PUBLISHABLE_KEY` | Clerk Publishable Key | `pk_test_...` |
| `CLERK_SECRET_KEY` | Clerk Secret Key | `sk_test_...` |
| `GEMINI_API_KEY` | Google Gemini API Key | `AIzaSy...` |
| `EMBEDDING_MODEL` | Gemini embedding model | `gemini-embedding-001` |
| `EMBEDDING_DIMENSION` | Vector dimension size | `768` |
| `RAG_CHUNK_SIZE` | Chunk size (in tokens) | `600` |
| `RAG_CHUNK_OVERLAP` | Overlap (in tokens) | `100` |
| `RAG_TOP_K` | Number of passages to retrieve | `4` |
| `RAG_SIMILARITY_THRESHOLD` | Cosine similarity cutoff | `0.25` |
| `MAX_PDF_SIZE_MB` | Upload file size limit in MB | `10` |
| `RAG_LLM_MODEL` | Chat completion model | `gemini-3.5-flash-lite` |
| `PORT` | Express listening port | `3000` |

### Client (`client/.env`)
| Variable | Description | Example |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk Frontend Publishable Key | `pk_test_...` |
| `VITE_BASE_URL` | Express Backend Base URL | `http://localhost:3000` |

---

## 5. Local Development Setup

### 1. Install Dependencies
```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### 2. Start Services
```bash
# Terminal 1 - Backend (http://localhost:3000)
cd server
npm run server

# Terminal 2 - Frontend (http://localhost:5173)
cd client
npm run dev
```

---

## 6. Running Automated Tests

The backend includes automated unit and integration tests using Node.js's native test runner (`node:test` and `node:assert/strict`):

```bash
cd server
npm test
```

### Tests Covered:
- PDF upload validation (MIME, extension, size limits).
- Page-by-page text extraction with 1-indexed page number preservation.
- Error handling on corrupted, empty, or unextractable PDFs.
- Text chunking with configurable tokens, overlap, and metadata retention.
- Safe temporary file cleanup.
- Grounded answer generation and verified citation formatting.
- Fallback admission when documents lack relevant information.
- Cross-user authorization and tenant isolation checks.
- Embedding configuration and dimension defaults.

---

## 7. Manual End-to-End Testing Checklist

1. **Authentication**: Sign in via Clerk on the frontend. Confirm authenticated state.
2. **Access Page**: Navigate to **Chat with PDF** (`/ai/chat-pdf`) from the sidebar or dashboard card.
3. **Upload Valid PDF**: Upload a multi-page PDF (< 10 MB). Confirm the upload status spinner transitions to `Ready` with page and chunk counts.
4. **Invalid Upload Test**: Try uploading a non-PDF file or a file > 10 MB. Verify that clear toast error notifications appear.
5. **Ask In-Document Question**: Ask a question whose answer is on Page 2 or 3 of the uploaded document. Confirm the assistant answers accurately and displays a `Page X` citation pill.
6. **Citation Verification**: Click the citation badge to expand and inspect the source excerpt snippet and similarity score.
7. **Ask Out-of-Document Question**: Ask a question unrelated to the document content. Verify the assistant states that the document does not contain sufficient information.
8. **Clear Chat**: Click "Clear Chat" and confirm message history resets.
9. **Delete Document**: Click the trash icon on the document item in the sidebar; confirm document and related records are removed.

---

## 8. Deployment Considerations

- **Serverless / Vercel Execution Limits**:
  - Node.js serverless functions on Vercel have a default execution timeout (10s on Hobby, 60s on Pro).
  - For large documents (> 50 pages), chunking and batch embedding generation should either be kept within batch limits (e.g. 30 chunks per batch) or offloaded to a background worker or asynchronous queue if deployed in a strict serverless environment.
- **Ephemeral Storage**:
  - Serverless platforms like Vercel have read-only filesystems outside of `/tmp`. Multer disk storage writes to the system temp directory and `pdfService` cleans up immediately upon parsing or failure.
- **pgvector on Neon**:
  - Neon supports `pgvector` natively. Ensure your database compute endpoint has `vector` enabled (automatically done via `runMigrations()`).

---

## 9. Known Limitations

- **Scanned / Image-Only PDFs**: OCR is not included in this release. Documents containing scanned images without embedded text layers will be rejected with an informative error message advising the user.
- **Password-Protected PDFs**: Encrypted or password-protected PDFs cannot be extracted and are rejected during validation.
