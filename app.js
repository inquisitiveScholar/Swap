const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5143;
const MAX_IMAGE_SIZE_MB = 3;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const BACKEND_DOMAIN = "https://metastorage.poodl.org";

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'server.log' })
  ]
});

// Enhanced CORS configuration
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? ['https://launchpad.poodl.org']
  : ['http://localhost:5173'];



app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      logger.info(`Allowed CORS request from: ${origin}`);
      callback(null, true);
    } else {
      logger.warn(`Blocked CORS request from: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Configure file upload with enhanced logging
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = 'tmp/uploads/';
      fs.ensureDir(uploadDir)
        .then(() => {
          logger.info(`Upload directory ready: ${uploadDir}`);
          cb(null, uploadDir);
        })
        .catch(err => {
          logger.error(`Failed to create upload directory: ${err.message}`);
          cb(err);
        });
    },
    filename: (req, file, cb) => {
      const filename = `${uuidv4()}${path.extname(file.originalname)}`;
      logger.info(`Generated filename: ${filename}`);
      cb(null, filename);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      logger.info(`Accepted file type: ${file.mimetype}`);
      cb(null, true);
    } else {
      const error = new Error(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, and GIF images are allowed.`);
      logger.warn(`File type rejected: ${error.message}`);
      cb(error);
    }
  },
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES, // 3MB limit
    files: 1
  }
});

// Configure storage with error handling
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
try {
  fs.ensureDirSync(STORAGE_DIR);
  fs.ensureDirSync('tmp/uploads');
  logger.info(`Storage directories initialized: ${STORAGE_DIR}, tmp/uploads`);
} catch (err) {
  logger.error(`Failed to initialize storage directories: ${err.message}`);
  process.exit(1);
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  });
  next();
});

// API endpoint with comprehensive error handling and duplicate check
app.post('/store', upload.single('image'), async (req, res) => {
  const requestId = uuidv4();
  const logContext = { requestId };

  try {
    logger.info('Starting metadata storage process', logContext);

    // Validate required fields
    const requiredFields = ['projectName', 'projectDescription', 'chainID', 'tokenAddress'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      logger.warn('Missing required fields', { ...logContext, missingFields });
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`,
        requiredFields: {
          projectName: 'string',
          projectDescription: 'string',
          chainID: 'number',
          tokenAddress: 'string',
          website: 'string (optional)',
          twitter: 'string (optional)',
          telegram: 'string (optional)',
          discord: 'string (optional)',
          image: `image file (required, max ${MAX_IMAGE_SIZE_MB}MB)`
        }
      });
    }

    // Check if project already exists
    const projectDir = path.join(
      STORAGE_DIR,
      req.body.chainID,
      req.body.tokenAddress
    );
    const metadataPath = path.join(projectDir, 'metadata.json');
    
    if (await fs.pathExists(metadataPath)) {
      logger.info('Project already exists, returning existing data', { ...logContext, projectDir });
      const existingMetadata = await fs.readJson(metadataPath);
      
      // Find the image file in the directory
      const files = await fs.readdir(projectDir);
      const imageFile = files.find(file => 
        ['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(file).toLowerCase())
      );
      
      return res.status(200).json({
        success: true,
        message: 'Project already exists',
        metadataUrl: `${BACKEND_DOMAIN}/storage/${req.body.chainID}/${req.body.tokenAddress}/metadata.json`,
        imageUrl: imageFile 
          ? `${BACKEND_DOMAIN}/storage/${req.body.chainID}/${req.body.tokenAddress}/${imageFile}`
          : null,
        existing: true
      });
    }

    if (!req.file) {
      logger.warn('No file uploaded', logContext);
      return res.status(400).json({
        success: false,
        error: 'Project image is required'
      });
    }

    // Create project directory structure
    logger.info(`Creating project directory: ${projectDir}`, logContext);
    await fs.ensureDir(projectDir);

    // Process image
    const imageExt = path.extname(req.file.originalname);
    const imageFilename = `project-image${imageExt}`;
    const imagePath = path.join(projectDir, imageFilename);
    
    logger.info(`Moving uploaded file to: ${imagePath}`, logContext);
    await fs.move(req.file.path, imagePath);

    // Prepare metadata
    const metadata = {
      projectName: req.body.projectName,
      projectDescription: req.body.projectDescription,
      chainID: req.body.chainID,
      tokenAddress: req.body.tokenAddress,
      website: req.body.website || '',
      twitter: req.body.twitter || '',
      telegram: req.body.telegram || '',
      discord: req.body.discord || '',
      imageUrl: `${BACKEND_DOMAIN}/storage/${req.body.chainID}/${req.body.tokenAddress}/${imageFilename}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save metadata
    logger.info(`Saving metadata to: ${metadataPath}`, { ...logContext, metadata });
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Success response for new upload
    logger.info('Metadata storage successful', { ...logContext, projectId: `${req.body.chainID}/${req.body.tokenAddress}` });
    res.status(201).json({
      success: true,
      message: 'Project metadata stored successfully',
      metadataUrl: `${BACKEND_DOMAIN}/storage/${req.body.chainID}/${req.body.tokenAddress}/metadata.json`,
      imageUrl: `${BACKEND_DOMAIN}/storage/${req.body.chainID}/${req.body.tokenAddress}/${imageFilename}`
    });

  } catch (error) {
    logger.error('Metadata storage failed', { ...logContext, error: error.message, stack: error.stack });
    
    // Cleanup if error occurred
    if (req.file?.path) {
      try {
        await fs.remove(req.file.path);
        logger.info('Cleaned up temporary upload file', logContext);
      } catch (cleanupError) {
        logger.error('Failed to clean up temporary file', { ...logContext, error: cleanupError.message });
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to store project metadata',
      ...(process.env.NODE_ENV === 'development' && { 
        details: error.message,
        requestId
      })
    });
  }
});

// Serve static files
app.use('/storage', express.static(STORAGE_DIR, {
  setHeaders: (res, filePath) => {
    if (path.extname(filePath) === '.json') {
      res.setHeader('Content-Type', 'application/json');
    }
  }
}));

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  const errorId = uuidv4();
  logger.error('Server error', {
    errorId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  });

  if (err instanceof multer.MulterError) {
    const errorDetails = {
      LIMIT_FILE_SIZE: `File size exceeds ${MAX_IMAGE_SIZE_MB}MB limit`,
      LIMIT_FILE_COUNT: 'Too many files uploaded',
      LIMIT_FIELD_KEY: 'Field name too long',
      LIMIT_FIELD_VALUE: 'Field value too long',
      LIMIT_FIELD_COUNT: 'Too many fields'
    };
    
    return res.status(400).json({
      success: false,
      error: 'File upload error',
      details: errorDetails[err.code] || err.message,
      errorId
    });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'CORS policy blocked this request',
      allowedOrigins,
      errorId
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    errorId,
    ...(process.env.NODE_ENV === 'development' && { details: err.message })
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`, {
    environment: process.env.NODE_ENV || 'development',
    storageDir: STORAGE_DIR,
    allowedOrigins,
    maxImageSize: `${MAX_IMAGE_SIZE_MB}MB`
  });
  
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Storage directory: ${STORAGE_DIR}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`Max image size: ${MAX_IMAGE_SIZE_MB}MB`);
});

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: reason.toString(), promise });
});
