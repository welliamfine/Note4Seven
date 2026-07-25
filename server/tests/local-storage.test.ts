import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { loadConfig } from '../src/config';
import { LocalStorageService } from '../src/services/local-storage';

describe('local development storage', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('writes, validates, reads and exposes a development object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'record-life-storage-'));
    directories.push(directory);
    const config = loadConfig({
      MYSQL_ADDRESS: '127.0.0.1:3306',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'local',
      LOCAL_STORAGE_PATH: directory,
      LOCAL_PUBLIC_BASE_URL: 'http://127.0.0.1:8080/',
    });
    const storage = new LocalStorageService(config);
    const key = 'media/1/2/original.png';
    const body = Buffer.from('local-image');

    await expect(storage.createUpload(key)).resolves.toMatchObject({ method: 'LOCAL', cloudPath: key });
    await storage.writeUpload(key, body);
    await expect(storage.assertUploaded(key, body.length)).resolves.toBeUndefined();
    await expect(storage.readObject(key)).resolves.toMatchObject({ body, contentType: 'image/png' });
    await expect(storage.signedUrl(key)).resolves.toBe(
      'http://127.0.0.1:8080/api/v1/dev-storage/file?key=media%2F1%2F2%2Foriginal.png',
    );
  });

  it('rejects traversal and incorrect upload sizes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'record-life-storage-'));
    directories.push(directory);
    const config = loadConfig({
      MYSQL_ADDRESS: '127.0.0.1:3306',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'local',
      LOCAL_STORAGE_PATH: directory,
    });
    const storage = new LocalStorageService(config);

    await expect(storage.createUpload('../outside.png')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await storage.writeUpload('media/1/2/original.png', Buffer.from('1234'));
    await expect(storage.assertUploaded('media/1/2/original.png', 3)).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_INVALID' });
  });

  it('creates a full PNG sticker and a bounded WebP display asset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'record-life-storage-'));
    directories.push(directory);
    const config = loadConfig({
      MYSQL_ADDRESS: '127.0.0.1:3306',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'local',
      LOCAL_STORAGE_PATH: directory,
    });
    const storage = new LocalStorageService(config);
    const original = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 80, g: 140, b: 210 } },
    }).jpeg({ quality: 88 }).toBuffer();
    const keys = {
      original: 'media/1/3/original.jpg',
      detailThumbnail: 'media/1/3/detail.webp',
      sticker: 'media/1/3/sticker.png',
      stickerThumbnail: 'media/1/3/sticker-thumb.webp',
    };
    await storage.writeUpload(keys.original, original);

    await storage.processImage(keys);

    const full = await storage.readObject(keys.sticker);
    const thumbnail = await storage.readObject(keys.stickerThumbnail);
    const thumbnailMetadata = await sharp(thumbnail.body).metadata();
    expect(full.contentType).toBe('image/png');
    expect(thumbnail.contentType).toBe('image/webp');
    expect(Math.max(thumbnailMetadata.width ?? 0, thumbnailMetadata.height ?? 0)).toBeLessThanOrEqual(640);
    expect(thumbnail.body.length).toBeLessThan(full.body.length);
  });
});
