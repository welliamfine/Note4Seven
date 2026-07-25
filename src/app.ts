import { initializeApi, runInAppReminderScan } from './services/api';
import { track } from './services/tracker';
import { API_MODE, CLOUD_ENV_ID } from './config/runtime';

App({
  globalData: {
    statusBarHeight: 24,
  },
  onLaunch(options) {
    if (API_MODE === 'remote') wx.cloud.init({ env: CLOUD_ENV_ID });
    const windowInfo = wx.getWindowInfo?.();
    this.globalData.statusBarHeight = windowInfo?.statusBarHeight ?? 24;
    initializeApi();
    runInAppReminderScan();
    track('app_open', {
      launchType: options.scene ? 'scene' : 'direct',
      sceneCode: String(options.scene ?? ''),
      firstOpen: false,
      loginStatus: API_MODE === 'remote'
        ? 'cloud_authenticated'
        : API_MODE === 'dev-server' ? 'dev_server_authenticated' : 'local_authenticated',
    });
  },
});
