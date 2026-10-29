import express from 'express';
import { upload } from '../controllers/multer.js';
import {
  uploadDocument,
  getDocuments,
  getDocumentStatus,
  getDocumentMessages,
  chatWithDocument,
  deleteDocument,
  clearDocumentMessages,
} from '../controllers/documentController.js';

const documentRouter = express.Router();

// Middleware to normalize multer field name ('pdf' or 'file')
const uploadMiddleware = (req, res, next) => {
  const single = upload.single('pdf');
  single(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      // try 'file' if 'pdf' wasn't sent
      const fileSingle = upload.single('file');
      return fileSingle(req, res, next);
    }
    next();
  });
};

// Document management & ingestion
documentRouter.post('/upload', uploadMiddleware, uploadDocument);
documentRouter.get('/', getDocuments);
documentRouter.get('/:id/status', getDocumentStatus);
documentRouter.get('/:id/messages', getDocumentMessages);
documentRouter.post('/:id/chat', chatWithDocument);
documentRouter.delete('/:id/messages', clearDocumentMessages);
documentRouter.delete('/:id', deleteDocument);

export default documentRouter;
