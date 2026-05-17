//  MIME type file extension map 

export const MIME_TO_EXTENSION = {
    'application/pdf':                                                          'pdf',
    'application/msword':                                                       'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel':                                                 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       'xlsx',
    'image/jpeg':                                                               'jpg',
    'image/png':                                                                'png',
    'image/tiff':                                                               'tiff',
    'image/webp':                                                               'webp',
    'text/plain':                                                               'txt',
    'text/csv':                                                                 'csv',
  };
  
  export const SUPPORTED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXTENSION));
  
  // Max upload size: 500 MB
  export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
  
  // Presigned URL default TTL
  export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;