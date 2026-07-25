import { syncPrivacyConsent } from '../../services/api';

type PrivacyDecision = {
  event: 'exposureAuthorization' | 'agree' | 'disagree';
  buttonId?: string;
};

type PrivacyResolver = (decision: PrivacyDecision) => void;
type PrivacyListener = (resolve: PrivacyResolver, eventInfo: { referrer: string }) => void;

let pendingResolver: PrivacyResolver | null = null;
let consentSynced = false;

function syncConsentOnce(agreed: boolean): void {
  if (agreed && consentSynced) return;
  void syncPrivacyConsent(agreed)
    .then(() => {
      consentSynced = agreed;
    })
    .catch(() => undefined);
}

Component({
  data: {
    visible: false,
  },

  lifetimes: {
    attached() {
      const register = wx.onNeedPrivacyAuthorization as unknown as (listener: PrivacyListener) => void;
      register((resolve) => {
        pendingResolver = resolve;
        this.setData({ visible: true });
        resolve({ event: 'exposureAuthorization' });
      });

      wx.requirePrivacyAuthorize({
        success: () => syncConsentOnce(true),
        fail: () => undefined,
      });
    },
  },

  methods: {
    openPrivacyContract() {
      wx.openPrivacyContract({});
    },

    agreePrivacyAuthorization() {
      const resolve = pendingResolver;
      pendingResolver = null;
      this.setData({ visible: false });
      resolve?.({ buttonId: 'privacy-agree-button', event: 'agree' });
      syncConsentOnce(true);
    },

    disagreePrivacyAuthorization() {
      const resolve = pendingResolver;
      pendingResolver = null;
      this.setData({ visible: false });
      resolve?.({ event: 'disagree' });
      syncConsentOnce(false);
    },
  },
});
