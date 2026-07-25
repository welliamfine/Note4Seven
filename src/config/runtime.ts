declare const __API_MODE__: 'local' | 'dev-server' | 'remote';
declare const __TARGET_ENVIRONMENT__: 'development' | 'staging' | 'production';
declare const __CLOUD_ENV_ID__: string;
declare const __CLOUD_SERVICE__: string;
declare const __SUBSCRIBE_TEMPLATE_ID__: string;
declare const __RELEASE_ID__: string;

export const API_MODE = typeof __API_MODE__ === 'undefined' ? 'local' : __API_MODE__;
export const TARGET_ENVIRONMENT = typeof __TARGET_ENVIRONMENT__ === 'undefined' ? 'development' : __TARGET_ENVIRONMENT__;
export const CLOUD_ENV_ID = typeof __CLOUD_ENV_ID__ === 'undefined' ? 'local-development' : __CLOUD_ENV_ID__;
export const CLOUD_SERVICE = typeof __CLOUD_SERVICE__ === 'undefined' ? 'local-backend' : __CLOUD_SERVICE__;
export const SUBSCRIBE_TEMPLATE_ID = typeof __SUBSCRIBE_TEMPLATE_ID__ === 'undefined' ? '' : __SUBSCRIBE_TEMPLATE_ID__;
export const RELEASE_ID = typeof __RELEASE_ID__ === 'undefined' ? 'development' : __RELEASE_ID__;
