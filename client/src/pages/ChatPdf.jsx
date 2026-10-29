import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '@clerk/clerk-react';
import toast from 'react-hot-toast';
import Markdown from 'react-markdown';
import {
  FileText,
  Upload,
  Send,
  Trash2,
  Sparkles,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

axios.defaults.baseURL = import.meta.env.VITE_BASE_URL;

const ChatPdf = () => {
  const { getToken } = useAuth();

  // State
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputQuestion, setInputQuestion] = useState('');
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [expandedCitations, setExpandedCitations] = useState({});

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Scroll to bottom when messages update
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, chatLoading]);

  // Load documents on mount
  useEffect(() => {
    fetchDocuments();
  }, []);

  // When selectedDoc changes, fetch its messages
  useEffect(() => {
    if (selectedDoc && selectedDoc.status === 'ready') {
      fetchMessages(selectedDoc.id);
    } else {
      setMessages([]);
    }
  }, [selectedDoc]);

  const getAuthHeaders = async () => {
    const token = await getToken();
    return { Authorization: `Bearer ${token}` };
  };

  const fetchDocuments = async () => {
    try {
      setLoadingDocs(true);
      const headers = await getAuthHeaders();
      const { data } = await axios.get('/api/documents', { headers });
      if (data.success) {
        setDocuments(data.documents || []);
        // Auto-select first ready document if none selected
        if (!selectedDoc && data.documents?.length > 0) {
          const readyDoc = data.documents.find((d) => d.status === 'ready') || data.documents[0];
          setSelectedDoc(readyDoc);
        }
      }
    } catch (err) {
      console.error('Error fetching documents:', err);
      toast.error('Failed to load your documents');
    } finally {
      setLoadingDocs(false);
    }
  };

  const fetchMessages = async (docId) => {
    try {
      const headers = await getAuthHeaders();
      const { data } = await axios.get(`/api/documents/${docId}/messages`, { headers });
      if (data.success) {
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error('Error fetching messages:', err);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF documents are supported');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('File size exceeds 10 MB limit');
      return;
    }

    const formData = new FormData();
    formData.append('pdf', file);

    try {
      setUploading(true);
      const headers = await getAuthHeaders();
      const { data } = await axios.post('/api/documents/upload', formData, {
        headers: {
          ...headers,
          'Content-Type': 'multipart/form-data',
        },
      });

      if (data.success) {
        toast.success('Document processed successfully!');
        if (fileInputRef.current) fileInputRef.current.value = '';
        await fetchDocuments();
        if (data.document) {
          setSelectedDoc(data.document);
        }
      } else {
        toast.error(data.message || 'Failed to process PDF');
      }
    } catch (err) {
      console.error('Upload error:', err);
      toast.error(err.response?.data?.message || err.message || 'Failed to upload PDF');
    } finally {
      setUploading(false);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputQuestion.trim() || !selectedDoc || chatLoading) return;

    if (selectedDoc.status !== 'ready') {
      toast.error('This document is not ready yet');
      return;
    }

    const question = inputQuestion.trim();
    setInputQuestion('');

    // Optimistically append user message
    const tempUserMsg = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: question,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setChatLoading(true);

    try {
      const headers = await getAuthHeaders();
      const { data } = await axios.post(
        `/api/documents/${selectedDoc.id}/chat`,
        { question },
        { headers }
      );

      if (data.success) {
        const assistantMsg = data.message || {
          id: `resp-${Date.now()}`,
          role: 'assistant',
          content: data.answer,
          citations: data.citations || [],
          created_at: new Date().toISOString(),
        };
        // Replace or append
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        toast.error(data.message || 'Failed to get answer');
      }
    } catch (err) {
      console.error('Chat error:', err);
      toast.error(err.response?.data?.message || 'Error communicating with RAG assistant');
    } finally {
      setChatLoading(false);
    }
  };

  const handleDeleteDocument = async (docId, e) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this document and its chat history?')) {
      return;
    }

    try {
      const headers = await getAuthHeaders();
      const { data } = await axios.delete(`/api/documents/${docId}`, { headers });
      if (data.success) {
        toast.success('Document deleted');
        if (selectedDoc?.id === docId) {
          setSelectedDoc(null);
          setMessages([]);
        }
        await fetchDocuments();
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to delete document');
    }
  };

  const handleClearChat = async () => {
    if (!selectedDoc) return;
    if (!window.confirm('Clear all conversation history for this document?')) return;

    try {
      const headers = await getAuthHeaders();
      const { data } = await axios.delete(`/api/documents/${selectedDoc.id}/messages`, { headers });
      if (data.success) {
        toast.success('Chat history cleared');
        setMessages([]);
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to clear chat');
    }
  };

  const toggleCitation = (msgIndex, citeIndex) => {
    const key = `${msgIndex}-${citeIndex}`;
    setExpandedCitations((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className='h-full flex flex-col md:flex-row overflow-hidden bg-[#F4F7FB] text-slate-700'>
      {/* LEFT PANEL: Document Management & Upload */}
      <div className='w-full md:w-80 lg:w-96 bg-white border-r border-gray-200 flex flex-col h-auto md:h-full'>
        {/* Header */}
        <div className='p-4 border-b border-gray-100 flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className='p-2 bg-indigo-50 text-indigo-600 rounded-lg'>
              <BookOpen className='w-5 h-5' />
            </div>
            <div>
              <h1 className='font-semibold text-base text-gray-800'>PDF Knowledge Base</h1>
              <p className='text-xs text-gray-400'>RAG Semantic Retrieval</p>
            </div>
          </div>
          <button
            onClick={fetchDocuments}
            title='Refresh documents'
            className='p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition'
          >
            <RefreshCw className={`w-4 h-4 ${loadingDocs ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Upload Box */}
        <div className='p-4'>
          <label
            htmlFor='pdf-upload-input'
            className={`border-2 border-dashed rounded-xl p-4 flex flex-col items-center justify-center cursor-pointer transition ${
              uploading
                ? 'border-indigo-400 bg-indigo-50/40'
                : 'border-gray-200 hover:border-indigo-400 hover:bg-gray-50'
            }`}
          >
            <input
              id='pdf-upload-input'
              ref={fileInputRef}
              type='file'
              accept='application/pdf'
              className='hidden'
              onChange={handleFileUpload}
              disabled={uploading}
            />
            {uploading ? (
              <div className='flex flex-col items-center py-2'>
                <Loader2 className='w-8 h-8 text-indigo-600 animate-spin mb-2' />
                <span className='text-xs font-medium text-indigo-700'>Chunking & Vectorizing...</span>
                <span className='text-[10px] text-gray-400 mt-1'>Generating embeddings</span>
              </div>
            ) : (
              <div className='flex flex-col items-center py-1 text-center'>
                <div className='w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mb-2'>
                  <Upload className='w-5 h-5' />
                </div>
                <span className='text-xs font-semibold text-gray-700'>Click to upload PDF</span>
                <span className='text-[11px] text-gray-400 mt-0.5'>Supports up to 10 MB</span>
              </div>
            )}
          </label>
        </div>

        {/* Document List */}
        <div className='flex-1 overflow-y-auto px-4 pb-4 space-y-2'>
          <div className='flex items-center justify-between text-xs font-medium text-gray-400 px-1 py-1'>
            <span>Your Documents ({documents.length})</span>
          </div>

          {documents.length === 0 ? (
            <div className='text-center py-8 px-2 text-gray-400 text-xs'>
              <FileText className='w-8 h-8 mx-auto mb-2 text-gray-300' />
              <p>No documents uploaded yet.</p>
              <p className='text-[11px] text-gray-400 mt-1'>Upload a PDF to start asking grounded questions.</p>
            </div>
          ) : (
            documents.map((doc) => {
              const isSelected = selectedDoc?.id === doc.id;
              return (
                <div
                  key={doc.id}
                  onClick={() => setSelectedDoc(doc)}
                  className={`p-3 rounded-xl border cursor-pointer transition flex items-start justify-between gap-2 ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-50/50 shadow-sm'
                      : 'border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50/80'
                  }`}
                >
                  <div className='flex items-start gap-2.5 min-w-0'>
                    <div
                      className={`p-2 rounded-lg mt-0.5 ${
                        isSelected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      <FileText className='w-4 h-4' />
                    </div>
                    <div className='min-w-0'>
                      <h4 className='text-xs font-semibold text-gray-800 truncate' title={doc.filename}>
                        {doc.filename}
                      </h4>
                      <div className='flex items-center gap-2 mt-1 text-[11px] text-gray-400'>
                        <span>{(doc.file_size / 1024).toFixed(0)} KB</span>
                        {doc.total_pages > 0 && <span>• {doc.total_pages} {doc.total_pages === 1 ? 'page' : 'pages'}</span>}
                      </div>

                      {/* Status indicator */}
                      <div className='mt-1.5 flex items-center gap-1.5'>
                        {doc.status === 'ready' && (
                          <span className='inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full'>
                            <CheckCircle2 className='w-3 h-3' /> Ready ({doc.total_chunks} chunks)
                          </span>
                        )}
                        {doc.status === 'processing' && (
                          <span className='inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full'>
                            <Loader2 className='w-3 h-3 animate-spin' /> Processing
                          </span>
                        )}
                        {doc.status === 'failed' && (
                          <span
                            className='inline-flex items-center gap-1 text-[10px] font-medium text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full'
                            title={doc.error_message}
                          >
                            <AlertCircle className='w-3 h-3' /> Failed
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Delete Button */}
                  <button
                    onClick={(e) => handleDeleteDocument(doc.id, e)}
                    className='text-gray-300 hover:text-rose-500 p-1 rounded transition'
                    title='Delete document'
                  >
                    <Trash2 className='w-3.5 h-3.5' />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* RIGHT PANEL: Chat Conversation Area */}
      <div className='flex-1 flex flex-col h-full bg-[#F8FAFC]'>
        {/* Top Active Bar */}
        <div className='bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='w-9 h-9 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center shadow-sm'>
              <Sparkles className='w-5 h-5' />
            </div>
            <div>
              <h2 className='text-sm font-semibold text-gray-800'>
                {selectedDoc ? selectedDoc.filename : 'Chat with PDF'}
              </h2>
              <p className='text-xs text-gray-400'>
                {selectedDoc
                  ? selectedDoc.status === 'ready'
                    ? `Ready • ${selectedDoc.total_pages} pages indexed`
                    : `Status: ${selectedDoc.status}`
                  : 'Select or upload a document to begin'}
              </p>
            </div>
          </div>

          {selectedDoc && messages.length > 0 && (
            <button
              onClick={handleClearChat}
              className='text-xs text-gray-500 hover:text-rose-600 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 hover:border-rose-200 hover:bg-rose-50/50 transition cursor-pointer'
            >
              <Trash2 className='w-3.5 h-3.5' />
              <span>Clear Chat</span>
            </button>
          )}
        </div>

        {/* Message Stream */}
        <div className='flex-1 overflow-y-auto p-4 sm:p-6 space-y-4'>
          {!selectedDoc ? (
            <div className='h-full flex flex-col items-center justify-center text-center p-6 text-gray-400'>
              <div className='w-16 h-16 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4'>
                <BookOpen className='w-8 h-8' />
              </div>
              <h3 className='text-base font-semibold text-gray-700'>No Document Selected</h3>
              <p className='text-xs text-gray-500 max-w-sm mt-1'>
                Upload a PDF file using the left sidebar or select an existing document to start asking questions grounded in its text.
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className='h-full flex flex-col items-center justify-center text-center p-6 text-gray-400'>
              <div className='w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center mb-3'>
                <Sparkles className='w-7 h-7' />
              </div>
              <h3 className='text-sm font-semibold text-gray-700'>Ask anything about this document</h3>
              <p className='text-xs text-gray-500 max-w-md mt-1'>
                The AI will search the document's vector embeddings, retrieve the most relevant passages, and provide answers with page-level citations.
              </p>
              <div className='mt-4 flex flex-wrap gap-2 justify-center max-w-lg'>
                <button
                  onClick={() => setInputQuestion('Can you give a concise summary of this document?')}
                  className='text-xs bg-white border border-gray-200 hover:border-indigo-400 hover:text-indigo-600 px-3 py-1.5 rounded-full transition shadow-2xs'
                >
                  "Can you give a concise summary of this document?"
                </button>
                <button
                  onClick={() => setInputQuestion('What are the key points and conclusions?')}
                  className='text-xs bg-white border border-gray-200 hover:border-indigo-400 hover:text-indigo-600 px-3 py-1.5 rounded-full transition shadow-2xs'
                >
                  "What are the key points and conclusions?"
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg, mIdx) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id || mIdx}
                  className={`flex items-start gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
                >
                  {!isUser && (
                    <div className='w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center shrink-0 shadow-2xs text-xs font-semibold'>
                      AI
                    </div>
                  )}

                  <div
                    className={`max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 shadow-2xs text-sm ${
                      isUser
                        ? 'bg-gradient-to-r from-[#3C81F6] to-[#9234EA] text-white rounded-tr-none'
                        : 'bg-white border border-gray-200 text-slate-700 rounded-tl-none'
                    }`}
                  >
                    {isUser ? (
                      <p className='whitespace-pre-wrap leading-relaxed'>{msg.content}</p>
                    ) : (
                      <div>
                        <div className='reset-tw leading-relaxed text-slate-700 text-sm'>
                          <Markdown>{msg.content}</Markdown>
                        </div>

                        {/* Citations block */}
                        {msg.citations && msg.citations.length > 0 && (
                          <div className='mt-3 pt-3 border-t border-gray-100'>
                            <div className='flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 mb-2'>
                              <Info className='w-3.5 h-3.5 text-indigo-500' />
                              <span>Source References & Citations:</span>
                            </div>
                            <div className='space-y-1.5'>
                              {msg.citations.map((cite, cIdx) => {
                                const isExpanded = expandedCitations[`${mIdx}-${cIdx}`];
                                return (
                                  <div
                                    key={cIdx}
                                    className='bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs transition'
                                  >
                                    <div
                                      onClick={() => toggleCitation(mIdx, cIdx)}
                                      className='flex items-center justify-between cursor-pointer text-indigo-600 font-medium'
                                    >
                                      <span className='inline-flex items-center gap-1.5'>
                                        <span className='px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold text-[10px]'>
                                          Page {cite.pageNumber}
                                        </span>
                                        {cite.similarity && (
                                          <span className='text-[10px] text-gray-400'>
                                            Match: {(cite.similarity * 100).toFixed(0)}%
                                          </span>
                                        )}
                                      </span>
                                      {isExpanded ? (
                                        <ChevronUp className='w-3.5 h-3.5 text-gray-400' />
                                      ) : (
                                        <ChevronDown className='w-3.5 h-3.5 text-gray-400' />
                                      )}
                                    </div>
                                    {isExpanded && (
                                      <div className='mt-2 p-2 bg-white rounded border border-gray-100 text-[11px] text-gray-600 italic leading-relaxed'>
                                        "{cite.snippet}"
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {chatLoading && (
            <div className='flex items-start gap-3 justify-start'>
              <div className='w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center shrink-0 shadow-2xs text-xs font-semibold'>
                AI
              </div>
              <div className='bg-white border border-gray-200 rounded-2xl rounded-tl-none p-4 shadow-2xs flex items-center gap-2 text-xs text-gray-500'>
                <Loader2 className='w-4 h-4 animate-spin text-indigo-600' />
                <span>Searching vector passages & synthesizing answer...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Bottom Input Form */}
        <div className='bg-white border-t border-gray-200 p-4'>
          <form onSubmit={handleSendMessage} className='max-w-4xl mx-auto flex items-center gap-2'>
            <input
              type='text'
              value={inputQuestion}
              onChange={(e) => setInputQuestion(e.target.value)}
              placeholder={
                selectedDoc
                  ? selectedDoc.status === 'ready'
                    ? `Ask a question about ${selectedDoc.filename}...`
                    : 'Document is not ready yet...'
                  : 'Select or upload a PDF first...'
              }
              disabled={!selectedDoc || selectedDoc.status !== 'ready' || chatLoading}
              className='flex-1 p-2.5 px-4 outline-none text-sm rounded-xl border border-gray-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed transition'
            />
            <button
              type='submit'
              disabled={!inputQuestion.trim() || !selectedDoc || selectedDoc.status !== 'ready' || chatLoading}
              className='bg-gradient-to-r from-[#3C81F6] to-[#9234EA] text-white p-2.5 px-5 rounded-xl text-sm font-medium flex items-center gap-2 hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer shadow-sm'
            >
              {chatLoading ? (
                <Loader2 className='w-4 h-4 animate-spin' />
              ) : (
                <Send className='w-4 h-4' />
              )}
              <span className='hidden sm:inline'>Ask</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ChatPdf;
