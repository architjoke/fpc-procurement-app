import { createHash } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { createOcrProvider, isOcrResultUsable, parseOcrText } from '../services/ocr.js';

const router = Router();
const maximumImageSize = 1024 * 1024;
const minimumConfidence = 0.6;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maximumImageSize, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(new Error('Only image uploads are allowed.'));
      return;
    }
    callback(null, true);
  },
});
const ocrRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'OCR_RATE_LIMITED', message: 'Too many image scans. Try again in one minute.' },
});

const isSupportedImage = (buffer: Buffer): boolean =>
  (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
  (buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
  (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) ||
  (buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP');

router.post(
  '/parse',
  requireAuth,
  requireRole('centre_operator'),
  ocrRateLimit,
  (req, res, next) => {
    upload.single('image')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({
          code: tooLarge ? 'OCR_IMAGE_TOO_LARGE' : 'OCR_INVALID_UPLOAD',
          message: tooLarge ? 'Image must be 1 MB or smaller.' : 'Upload one image file only.',
        });
      }
      if (error instanceof Error) {
        return res.status(400).json({
          code: 'OCR_INVALID_UPLOAD',
          message: 'Only image uploads are allowed.',
        });
      }
      return next();
    });
  },
  async (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      return res.status(400).json({
        code: 'OCR_IMAGE_REQUIRED',
        message: 'Choose an image to scan.',
      });
    }
    if (!isSupportedImage(req.file.buffer)) {
      return res.status(400).json({
        code: 'OCR_INVALID_IMAGE',
        message: 'The uploaded file is not a supported image.',
      });
    }

    const imageReference = `sha256:${createHash('sha256').update(req.file.buffer).digest('hex')}`;
    let rawText = '';
    let confidence = 0;
    let providerFailed = false;
    let parsedValues: ReturnType<typeof parseOcrText> = {};

    try {
      const providerResult = await createOcrProvider().parse(req.file.buffer);
      rawText = typeof providerResult.rawText === 'string' ? providerResult.rawText : '';
      const providerWeight = providerResult.parsedWeight;
      const providerMoisture = providerResult.parsedMoisture;
      confidence =
        Number.isFinite(providerResult.confidence) &&
        providerResult.confidence >= 0 &&
        providerResult.confidence <= 1
          ? providerResult.confidence
          : 0;
      parsedValues = parseOcrText(rawText);
      if (
        parsedValues.parsedWeight === undefined &&
        providerWeight !== undefined &&
        Number.isFinite(providerWeight) &&
        providerWeight > 0
      ) {
        parsedValues.parsedWeight = providerWeight;
      }
      if (
        parsedValues.parsedMoisture === undefined &&
        providerMoisture !== undefined &&
        Number.isFinite(providerMoisture) &&
        providerMoisture >= 0 &&
        providerMoisture <= 100
      ) {
        parsedValues.parsedMoisture = providerMoisture;
      }
    } catch (error) {
      providerFailed = true;
      console.error('OCR provider could not process image:', error);
    }

    const usable =
      !providerFailed && isOcrResultUsable(confidence, parsedValues, minimumConfidence);
    let job: { id: string };
    try {
      job = await prisma.ocrJob.create({
        data: {
          operatorId: req.user!.id,
          imageUrl: imageReference,
          imageData: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
          rawOcrText: rawText,
          parsedWeight: parsedValues.parsedWeight ?? null,
          parsedMoisture: parsedValues.parsedMoisture ?? null,
          confidence,
          status: usable ? 'COMPLETED' : 'FAILED',
        },
      });
    } catch (error) {
      console.error('Unable to persist OCR job:', error);
      return res.status(500).json({
        code: 'OCR_JOB_PERSISTENCE_FAILED',
        message: 'Could not save the image scan. Please enter values manually.',
      });
    }

    const data = {
      jobId: job.id,
      parsedWeight: parsedValues.parsedWeight ?? null,
      parsedMoisture: parsedValues.parsedMoisture ?? null,
      confidence,
      photoReference: imageReference,
    };
    if (!usable) {
      return res.status(422).json({
        code: providerFailed ? 'OCR_UNAVAILABLE' : 'OCR_UNREADABLE',
        message: 'Could not read image, please enter manually.',
        data,
      });
    }

    return res.json({ data, message: 'OCR values extracted. Review and confirm each value.' });
  },
);

export { router as ocrRouter };
