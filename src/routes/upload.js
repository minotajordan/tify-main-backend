const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Determine resource type based on mimetype
    let resource_type = 'auto';
    if (file.mimetype.startsWith('image/')) {
        resource_type = 'image';
    } else if (file.mimetype.startsWith('video/')) {
        resource_type = 'video';
    } else {
        resource_type = 'raw';
    }

    return {
      folder: 'tify_uploads',
      resource_type: resource_type,
      use_filename: true,
      unique_filename: true,
    };
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    // Documents
    'application/pdf',
    'application/msword', // doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/vnd.ms-excel', // xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-powerpoint', // ppt
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'text/plain', 'text/csv',
    // Videos
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images, videos, PDF and Office documents are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: fileFilter
});

// Upload endpoint
router.post('/', upload.single('file'), (req, res) => {
  console.log('📂 Upload request received. Processing file...');
  try {
    if (!req.file) {
      console.warn('⚠️ Upload failed: No file received.');
      return res.status(400).json({ 
        error: 'No file uploaded', 
        hint: 'Ensure the form-data field name is "file".' 
      });
    }

    console.log(`✅ File uploaded to Cloudinary: ${req.file.originalname} (${req.file.size} bytes)`);
    
    // Construct response
    res.json({
      success: true,
      url: req.file.path, // Cloudinary URL
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Error handling middleware for Multer limits/filters
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 20MB.' });
    }
    return res.status(400).json({ error: err.message });
  } else if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
