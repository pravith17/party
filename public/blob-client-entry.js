import { upload } from '@vercel/blob/client';

window.uploadBlobPhoto = (file, slug, field, csrf, onProgress) => upload(
  `party/${slug}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
  file,
  {
    access: 'public',
    handleUploadUrl: `${location.origin}/api/blob-upload`,
    clientPayload: JSON.stringify({ slug, field }),
    contentType: file.type || 'application/octet-stream',
    multipart: true,
    headers: { 'x-csrf-token': csrf },
    onUploadProgress,
  },
);
