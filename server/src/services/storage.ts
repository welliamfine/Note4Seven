import COS from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import { isoWithShanghaiOffset } from '../lib/time';

interface TemporaryCredentials {
  TmpSecretId: string;
  TmpSecretKey: string;
  Token?: string;
  SecurityToken?: string;
  ExpiredTime: number;
  StartTime?: number;
}

export interface UploadInstruction {
  method: 'CLOUD' | 'LOCAL';
  cloudPath: string;
  expireAt: string;
}

export class StorageService {
  private readonly cos: COS;
  private cachedCredentials: TemporaryCredentials | null = null;

  constructor(private readonly config: AppConfig) {
    this.cos = new COS({
      getAuthorization: (options, callback) => {
        this.credentials()
          .then((credentials) => callback({
            Authorization: COS.getAuthorization({
              SecretId: credentials.TmpSecretId,
              SecretKey: credentials.TmpSecretKey,
              Method: options.Method,
              Pathname: options.Pathname,
              Query: options.Query,
              Headers: options.Headers,
              Expires: 900,
              SystemClockOffset: options.SystemClockOffset,
            }),
            SecurityToken: credentials.SecurityToken ?? credentials.Token,
          } as COS.GetAuthorizationCallbackParams))
          .catch(() => callback(''));
      },
    });
  }

  async createUpload(objectKey: string): Promise<UploadInstruction> {
    return {
      method: 'CLOUD',
      cloudPath: objectKey,
      expireAt: isoWithShanghaiOffset(new Date(Date.now() + 10 * 60 * 1000)),
    };
  }

  async integrationReadiness(): Promise<{ status: 'ready' | 'local' | 'unavailable'; mode: string }> {
    if (this.config.nodeEnv !== 'production') return { status: 'local', mode: 'filesystem' };
    try {
      await this.credentials();
      return { status: 'ready', mode: 'temporary-credentials' };
    } catch {
      return { status: 'unavailable', mode: 'temporary-credentials' };
    }
  }

  async assertUploaded(objectKey: string, expectedSize: number): Promise<void> {
    if (this.config.nodeEnv !== 'production') return;
    try {
      const metadata = await this.cos.headObject({
        Bucket: this.config.objectBucket,
        Region: this.config.cosRegion,
        Key: objectKey,
      });
      const actualSize = Number(metadata.headers?.['content-length'] ?? 0);
      if (actualSize <= 0 || actualSize !== expectedSize) {
        throw new AppError('MEDIA_UPLOAD_INVALID', '上传图片大小校验失败，请重新上传', 422);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('MEDIA_UPLOAD_NOT_FOUND', '尚未收到上传图片，请重新上传', 409);
    }
  }

  signedUrl(objectKey: string, expires = 600): Promise<string> {
    if (this.config.nodeEnv !== 'production') return Promise.resolve(`local://${objectKey}`);
    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl({
        Bucket: this.config.objectBucket,
        Region: this.config.cosRegion,
        Key: objectKey,
        Sign: true,
        Expires: expires,
        Protocol: 'https:',
      }, (error, data) => {
        if (error) reject(error);
        else resolve(data.Url);
      });
    });
  }

  async processImage(keys: {
    original: string;
    detailThumbnail: string;
    sticker: string;
    stickerThumbnail: string;
  }): Promise<void> {
    await this.cos.request({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Method: 'POST',
      Key: keys.original,
      Action: 'image_process',
      Headers: {
        'Pic-Operations': JSON.stringify({
          is_pic_info: 1,
          rules: [{
            fileid: `/${keys.sticker.replace(/^\/+/, '')}`,
            rule: 'ci-process=AIPicMatting&center-layout=1&padding-layout=16x16',
          }],
        }),
      },
    });
    await this.cos.request({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Method: 'POST',
      Key: keys.sticker,
      Action: 'image_process',
      Headers: {
        'Pic-Operations': JSON.stringify({
          is_pic_info: 1,
          rules: [{
            fileid: `/${keys.stickerThumbnail.replace(/^\/+/, '')}`,
            rule: 'imageMogr2/thumbnail/640x640>/format/webp/quality/82',
          }],
        }),
      },
    });
    await this.assertProcessedImage(keys.stickerThumbnail);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.cos.deleteMultipleObject({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Objects: keys.map((Key) => ({ Key })),
      Quiet: true,
    });
  }

  async putGeneratedObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.config.nodeEnv !== 'production') return;
    await this.putObject(key, body, contentType);
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    if (this.config.nodeEnv !== 'production') return;
    const encodedSource = sourceKey.split('/').map(encodeURIComponent).join('/');
    await this.cos.putObjectCopy({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Key: destinationKey,
      CopySource: `${this.config.objectBucket}.cos.${this.config.cosRegion}.myqcloud.com/${encodedSource}`,
      MetadataDirective: 'Copy',
    });
  }

  async createMemoryCardExport(input: {
    objectKey: string;
    moduleName: string;
    month: string;
    sourceKeys: string[];
  }): Promise<void> {
    if (this.config.nodeEnv !== 'production') return;
    const width = 1080;
    const height = 1440;
    const tileWidth = 430;
    const tileHeight = 430;
    const positions = [
      [80, 260], [570, 260], [80, 730], [570, 730],
    ];
    const selected = input.sourceKeys.slice(0, 4);
    const composites = await Promise.all(selected.map(async (key, index) => ({
      input: await sharp(await this.getObject(key))
        .resize({ width: tileWidth, height: tileHeight, fit: 'contain', background: { r: 247, g: 247, b: 244, alpha: 1 } })
        .webp({ quality: 88 })
        .toBuffer(),
      left: positions[index][0],
      top: positions[index][1],
    })));
    const title = escapeXml(input.moduleName);
    const month = escapeXml(input.month);
    const background = Buffer.from(`
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f7f7f4"/>
        <text x="80" y="105" font-family="sans-serif" font-size="54" font-weight="700" fill="#20231f">${title}</text>
        <text x="80" y="170" font-family="sans-serif" font-size="32" fill="#697069">${month} · 月度记录</text>
        <rect x="80" y="1260" width="920" height="2" fill="#d9ddd7"/>
        <text x="80" y="1335" font-family="sans-serif" font-size="28" fill="#697069">Note4Seven · 七日记</text>
      </svg>`);
    const card = await sharp(background)
      .composite(composites)
      .webp({ quality: 90 })
      .toBuffer();
    await this.putObject(input.objectKey, card, 'image/webp');
  }

  private async getObject(key: string): Promise<Buffer> {
    const result = await this.cos.getObject({ Bucket: this.config.objectBucket, Region: this.config.cosRegion, Key: key });
    if (Buffer.isBuffer(result.Body)) return result.Body;
    return Buffer.from(result.Body ?? '');
  }

  private async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.cos.putObject({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
    });
  }

  private async assertProcessedImage(key: string): Promise<void> {
    const metadata = await this.cos.headObject({
      Bucket: this.config.objectBucket,
      Region: this.config.cosRegion,
      Key: key,
    });
    const size = Number(metadata.headers?.['content-length'] ?? 0);
    const contentType = String(metadata.headers?.['content-type'] ?? '').toLowerCase();
    if (size <= 0 || (contentType && !contentType.startsWith('image/'))) {
      throw new AppError('CUTOUT_OUTPUT_INVALID', '贴纸文件校验失败，请重试', 502);
    }
  }

  private async credentials(): Promise<TemporaryCredentials> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedCredentials && this.cachedCredentials.ExpiredTime > now + 120) return this.cachedCredentials;
    if (this.config.nodeEnv !== 'production') {
      throw new AppError('COS_CREDENTIALS_UNAVAILABLE', '本地环境未配置对象存储', 503);
    }
    const response = await fetch(`${this.config.wechatOpenApiBase}/_/cos/getauth`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new AppError('COS_CREDENTIALS_UNAVAILABLE', '对象存储临时凭证获取失败', 503);
    const credentials = (await response.json()) as TemporaryCredentials;
    if (!credentials.TmpSecretId || !credentials.TmpSecretKey || !credentials.ExpiredTime) {
      throw new AppError('COS_CREDENTIALS_UNAVAILABLE', '对象存储临时凭证无效', 503);
    }
    this.cachedCredentials = credentials;
    return credentials;
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character);
}
