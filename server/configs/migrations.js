import sql from './db.js';

export async function runMigrations() {
  try {
    console.log('[Migration] Checking database schema & pgvector extension...');

    // 1. Enable pgvector
    await sql`CREATE EXTENSION IF NOT EXISTS vector;`;

    // 2. Documents table
    await sql`
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
    `;

    // 3. Document chunks table
    // embedding vector dimension defaults to 768 for gemini-embedding-001
    await sql`
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
    `;

    // 4. Document chat messages table
    await sql`
      CREATE TABLE IF NOT EXISTS document_chats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // 5. Indexes for fast retrieval and user isolation
    await sql`CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_chunks_user_id ON document_chunks(user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_chunks_doc_user ON document_chunks(document_id, user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_document_chats_doc_user ON document_chats(document_id, user_id, created_at ASC);`;

    // 6. Vector cosine index (HNSW index if supported, otherwise fallback silently to ivfflat or sequence scan)
    try {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON document_chunks USING hnsw (embedding vector_cosine_ops);
      `;
    } catch (indexErr) {
      console.warn('[Migration] Note: HNSW index creation skipped or not supported:', indexErr.message);
    }

    console.log('[Migration] Database schema and vector tables verified successfully! ✅');
  } catch (error) {
    console.error('[Migration] Migration error:', error.message);
    throw error;
  }
}
