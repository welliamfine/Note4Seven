import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import { StorageService, type UploadInstruction } from './storage';

export class LocalStorageService extends StorageService {
  private readonly root: string;

  constructor(private readonly localConfig: AppConfig) {
    super(localConfig);
    this.root = resolve(process.cwd(), localConfig.localStoragePath);
  }

  override async createUpload(objectKey: string): Promise<UploadInstruction> {
    this.objectPath(objectKey);
    return {
      method: 'LOCAL',
      cloudPath: objectKey,
      expireAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  async writeUpload(objectKey: string, body: Buffer): Promise<void> {
    const path = this.objectPath(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  override async assertUploaded(objectKey: string, expectedSize: number): Promise<void> {
    try {
      const metadata = await stat(this.objectPath(objectKey));
      if (!metadata.isFile() || metadata.size !== expectedSize) {
        throw new AppError('MEDIA_UPLOAD_INVALID', 'Local upload size check failed', 422);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('MEDIA_UPLOAD_NOT_FOUND', 'Local upload was not received', 409);
    }
  }

  override signedUrl(objectKey: string): Promise<string> {
    this.objectPath(objectKey);
    const key = encodeURIComponent(objectKey);
    return Promise.resolve(`${this.localConfig.localPublicBaseUrl}/api/v1/dev-storage/file?key=${key}`);
  }

  override async processImage(keys: {
    original: string;
    detailThumbnail: string;
    sticker: string;
    stickerThumbnail: string;
  }): Promise<void> {
    const original = await readFile(this.objectPath(keys.original));
    const sticker = await sharp(original).rotate().ensureAlpha().png().toBuffer();
    const thumbnail = await sharp(sticker)
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    await Promise.all([
      this.writeUpload(keys.sticker, sticker),
      this.writeUpload(keys.stickerThumbnail, thumbnail),
    ]);
  }

  override async deleteObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(this.objectPath(key), { force: true })));
  }

  override async putGeneratedObject(key: string, body: Buffer, contentType: string): Promise<void> {
    let output = body;
    if (contentType === 'image/png') {
      try {
        output = await sharp(body).png().toBuffer();
      } catch {
        output = await sharp({
          create: { width: 430, height: 430, channels: 4, background: { r: 247, g: 247, b: 244, alpha: 1 } },
        }).png().toBuffer();
      }
    }
    await this.writeUpload(key, output);
  }

  override async createMemoryCardExport(input: {
    objectKey: string;
    moduleName: string;
    month: string;
    sourceKeys: string[];
  }): Promise<void> {
    const card = await sharp({
      create: { width: 1080, height: 1440, channels: 4, background: { r: 247, g: 247, b: 244, alpha: 1 } },
    }).webp({ quality: 88 }).toBuffer();
    await this.writeUpload(input.objectKey, card);
  }

  async readObject(objectKey: string): Promise<{ body: Buffer; contentType: string }> {
    const path = this.objectPath(objectKey);
    return { body: await readFile(path), contentType: contentType(path) };
  }

  private objectPath(objectKey: string): string {
    if (!objectKey || objectKey.includes('..') || objectKey.includes('\\') || objectKey.startsWith('/')) {
      throw new AppError('VALIDATION_ERROR', 'Invalid local object key', 422);
    }
    const path = resolve(this.root, objectKey);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new AppError('VALIDATION_ERROR', 'Invalid local object key', 422);
    }
    return path;
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}
