import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { OcrSpaceProvider } from '../services/ocr.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const parseRequestSchema = z.object({
  fieldName: z.string().optional(),
});

router.post('/parse', requireAuth, upload.single('image'), async (req, res) => {
  try {
    parseRequestSchema.parse(req.body ?? {});

    if (!req.file) {
      return res.status(400).json({ message: 'An image upload is required.' });
    }

    const provider = new OcrSpaceProvider(process.env.OCR_SPACE_API_KEY);
    const result = await provider.parseImage(req.file);

    return res.json({
      data: {
        weight: result.weight,
        moisture: result.moisture,
        confidence: result.confidence,
        rawText: result.rawText,
        image: {
          thumbnail: '/public/ocr-sample-scale-1.jpg',
        },
      },
      message:
        result.source === 'fallback'
          ? 'OCR failed to read the image. Please enter values manually.'
          : 'OCR values extracted.',
    });
  } catch (error) {
    return res
      .status(400)
      .json({ message: 'OCR request failed.', error: (error as Error).message });
  }
});

export { router as ocrRouter };
