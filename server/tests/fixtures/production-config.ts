export const productionEnvironment = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  RELEASE_ID: 'test-release+000000000000',
  APP_ID: 'test-production-app',
  WECHAT_CLOUD_ENV_ID: 'test-production-environment',
  WECHAT_CLOUD_SERVICE: 'test-production-service',
  OBJECT_BUCKET: 'test-production-bucket-1234567890',
  COS_REGION: 'ap-shanghai',
  MYSQL_ADDRESS: 'db.internal:3306',
  MYSQL_USERNAME: 'app',
  MYSQL_PASSWORD: 'test-password',
  AUTO_MIGRATE: 'false',
} as const;
