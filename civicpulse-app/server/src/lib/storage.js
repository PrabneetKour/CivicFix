/**
 * Where uploaded evidence lives.
 *
 * Locally: the disk, under server/uploads, served back by Express. Simple, and it
 * survives a restart because your laptop has a real filesystem.
 *
 * Hosted: Cloudinary. Render, Railway and most free hosts wipe the filesystem on every
 * deploy and every restart, so anything written to disk disappears — including every
 * photo residents have filed. That is not a limitation you can work around by trying
 * harder; it needs object storage.
 *
 * The choice is made by whether CLOUDINARY_URL is set, so the same code runs in both
 * places without a flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';

const uploadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

export const usingCloudinary = Boolean(process.env.CLOUDINARY_URL);
if (usingCloudinary) cloudinary.config({ secure: true });   // reads CLOUDINARY_URL itself

/**
 * Takes a multer memory-storage file and returns a URL the browser can load.
 * @returns {Promise<{url: string, localPath: string|null}>}
 *   localPath is where EXIF can still be read from; null once the file is remote,
 *   in which case the buffer is handed to the caller instead.
 */
export async function storeUpload(file, folder = 'civicfix') {
  if (!usingCloudinary) {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`;
    const dest = path.join(uploadDir, name);
    await fs.promises.writeFile(dest, file.buffer);
    return { url: `/uploads/${name}`, localPath: dest };
  }

  const isVideo = file.mimetype.startsWith('video/');
  const uploaded = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: isVideo ? 'video' : 'image',
        // keep the original bytes: re-encoding an image strips the EXIF we read
        transformation: isVideo ? undefined : [{ quality: 'auto:good' }]
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(file.buffer);
  });

  return { url: uploaded.secure_url, localPath: null };
}

export const localUploadDir = uploadDir;
