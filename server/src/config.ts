import { z } from 'zod';

const booleanValue = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalNonEmptyString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).optional(),
  RELEASE_ID: optionalNonEmptyString,
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_ID: optionalNonEmptyString,
  WECHAT_CLOUD_ENV_ID: optionalNonEmptyString,
  WECHAT_CLOUD_SERVICE: optionalNonEmptyString,
  MYSQL_ADDRESS: optionalNonEmptyString,
  MYSQL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MYSQL_USERNAME: optionalNonEmptyString,
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_DATABASE: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  DB_HOST: optionalNonEmptyString,
  DB_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DB_USER: optionalNonEmptyString,
  DB_PASSWORD: z.string().optional(),
  DB_NAME: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  DB_POOL_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  OBJECT_BUCKET: optionalNonEmptyString,
  COS_REGION: optionalNonEmptyString,
  SUBSCRIBE_TEMPLATE_ID: optionalNonEmptyString,
  SUBSCRIBE_THING_KEY: z.string().min(1).default('thing1'),
  SUBSCRIBE_TIME_KEY: z.string().min(1).default('time2'),
  SUBSCRIBE_NOTE_KEY: z.string().min(1).default('thing3'),
  AUTO_MIGRATE: z.enum(['true', 'false']).optional().transform((value) => value === undefined ? undefined : value === 'true'),
  ALLOW_DEV_AUTH: booleanValue,
  ENABLE_WECHAT_CALLBACK: booleanValue,
  ENABLE_STORAGE_EVENTS: booleanValue,
  ENABLE_SUBSCRIPTIONS: booleanValue,
  ENABLE_METRICS: booleanValue,
  ENABLE_ANALYTICS: booleanValue,
  METRICS_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(24).optional()),
  ANALYTICS_HASH_SALT: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2592000).default(7200),
  WECHAT_OPEN_API_BASE: z.string().url().default('http://api.weixin.qq.com'),
  MINI_PROGRAM_CODE_ENV_VERSION: z.enum(['develop', 'trial', 'release']).default('trial'),
  PRIVACY_VERSION: z.string().min(1).default('1.0.0'),
  WECHAT_CALLBACK_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  WECHAT_CALLBACK_TOKEN_PREVIOUS: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  STORAGE_EVENT_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(24).optional()),
  STORAGE_EVENT_TOKEN_PREVIOUS: z.preprocess((value) => value === '' ? undefined : value, z.string().min(24).optional()),
  LOCAL_STORAGE_PATH: z.string().min(1).default('.local-storage'),
  LOCAL_PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  environment: 'development' | 'staging' | 'production';
  releaseId: string;
  port: number;
  appId: string;
  cloudEnvId: string;
  cloudService: string;
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
  };
  objectBucket: string;
  cosRegion: string;
  subscribeTemplateId: string;
  subscribeFields: { thing: string; time: string; note: string };
  autoMigrate: boolean;
  allowDevAuth: boolean;
  capabilities: {
    wechatCallback: boolean;
    storageEvents: boolean;
    subscriptions: boolean;
    metrics: boolean;
    analytics: boolean;
  };
  metricsToken: string | null;
  analyticsHashSalt: string | null;
  logLevel: string;
  sessionTtlSeconds: number;
  wechatOpenApiBase: string;
  miniProgramCodeEnvVersion: 'develop' | 'trial' | 'release';
  privacyVersion: string;
  wechatCallbackToken: string | null;
  wechatCallbackTokenPrevious: string | null;
  storageEventToken: string | null;
  storageEventTokenPrevious: string | null;
  localStoragePath: string;
  localPublicBaseUrl: string;
};

function parseAddress(address: string, explicitPort?: number): { host: string; port: number } {
  const separator = address.lastIndexOf(':');
  if (separator > 0 && !address.includes(']')) {
    const candidate = Number(address.slice(separator + 1));
    if (Number.isInteger(candidate) && candidate > 0) {
      return { host: address.slice(0, separator), port: explicitPort ?? candidate };
    }
  }
  return { host: address.replace(/^\[|\]$/g, ''), port: explicitPort ?? 3306 };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid server environment: ${fields}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.ALLOW_DEV_AUTH) {
    throw new Error('ALLOW_DEV_AUTH must be false in production');
  }
  const deploymentEnvironment = env.APP_ENV ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
  const autoMigrate = env.AUTO_MIGRATE ?? env.NODE_ENV !== 'production';
  if (env.NODE_ENV === 'production' && autoMigrate) {
    throw new Error('AUTO_MIGRATE must be false in production; run the explicit migration command before deployment');
  }
  const mysqlAddress = env.MYSQL_ADDRESS ?? env.DB_HOST;
  const mysqlUser = env.MYSQL_USERNAME ?? env.DB_USER;
  const mysqlPassword = env.MYSQL_PASSWORD ?? env.DB_PASSWORD;
  const missing = [
    !mysqlAddress && 'MYSQL_ADDRESS or DB_HOST',
    !mysqlUser && 'MYSQL_USERNAME or DB_USER',
    mysqlPassword === undefined && 'MYSQL_PASSWORD or DB_PASSWORD',
  ].filter(Boolean);
  if (env.NODE_ENV === 'production') {
    missing.push(...[
      !env.RELEASE_ID && 'RELEASE_ID',
      !env.APP_ID && 'APP_ID',
      !env.WECHAT_CLOUD_ENV_ID && 'WECHAT_CLOUD_ENV_ID',
      !env.WECHAT_CLOUD_SERVICE && 'WECHAT_CLOUD_SERVICE',
      !env.OBJECT_BUCKET && 'OBJECT_BUCKET',
      !env.COS_REGION && 'COS_REGION',
      env.ENABLE_WECHAT_CALLBACK && !env.WECHAT_CALLBACK_TOKEN && 'WECHAT_CALLBACK_TOKEN',
      env.ENABLE_STORAGE_EVENTS && !env.STORAGE_EVENT_TOKEN && 'STORAGE_EVENT_TOKEN',
      env.ENABLE_SUBSCRIPTIONS && !env.SUBSCRIBE_TEMPLATE_ID && 'SUBSCRIBE_TEMPLATE_ID',
      env.ENABLE_METRICS && !env.METRICS_TOKEN && 'METRICS_TOKEN',
      env.ENABLE_ANALYTICS && !env.ANALYTICS_HASH_SALT && 'ANALYTICS_HASH_SALT',
    ].filter(Boolean));
  }
  if (missing.length > 0) {
    throw new Error(`Invalid server environment: ${missing.join(', ')}`);
  }
  const address = parseAddress(mysqlAddress!, env.MYSQL_PORT ?? env.DB_PORT);
  return {
    nodeEnv: env.NODE_ENV,
    environment: deploymentEnvironment,
    releaseId: env.RELEASE_ID ?? 'development',
    port: env.PORT,
    appId: env.APP_ID ?? 'local-development-app',
    cloudEnvId: env.WECHAT_CLOUD_ENV_ID ?? 'local-development',
    cloudService: env.WECHAT_CLOUD_SERVICE ?? 'local-backend',
    mysql: {
      host: address.host,
      port: address.port,
      user: mysqlUser!,
      password: mysqlPassword!,
      database: env.MYSQL_DATABASE ?? env.DB_NAME ?? 'record_life',
      connectionLimit: env.DB_POOL_LIMIT,
    },
    objectBucket: env.OBJECT_BUCKET ?? 'local-development',
    cosRegion: env.COS_REGION ?? 'ap-shanghai',
    subscribeTemplateId: env.SUBSCRIBE_TEMPLATE_ID ?? '',
    subscribeFields: { thing: env.SUBSCRIBE_THING_KEY, time: env.SUBSCRIBE_TIME_KEY, note: env.SUBSCRIBE_NOTE_KEY },
    autoMigrate,
    allowDevAuth: env.ALLOW_DEV_AUTH,
    capabilities: {
      wechatCallback: env.ENABLE_WECHAT_CALLBACK,
      storageEvents: env.ENABLE_STORAGE_EVENTS,
      subscriptions: env.ENABLE_SUBSCRIPTIONS,
      metrics: env.ENABLE_METRICS,
      analytics: env.ENABLE_ANALYTICS,
    },
    metricsToken: env.METRICS_TOKEN ?? null,
    analyticsHashSalt: env.ANALYTICS_HASH_SALT ?? null,
    logLevel: env.LOG_LEVEL,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    wechatOpenApiBase: env.WECHAT_OPEN_API_BASE,
    miniProgramCodeEnvVersion: env.MINI_PROGRAM_CODE_ENV_VERSION,
    privacyVersion: env.PRIVACY_VERSION,
    wechatCallbackToken: env.WECHAT_CALLBACK_TOKEN ?? null,
    wechatCallbackTokenPrevious: env.WECHAT_CALLBACK_TOKEN_PREVIOUS ?? null,
    storageEventToken: env.STORAGE_EVENT_TOKEN ?? null,
    storageEventTokenPrevious: env.STORAGE_EVENT_TOKEN_PREVIOUS ?? null,
    localStoragePath: env.LOCAL_STORAGE_PATH,
    localPublicBaseUrl: env.LOCAL_PUBLIC_BASE_URL.replace(/\/$/, ''),
  };
}
