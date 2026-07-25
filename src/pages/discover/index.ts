import { track } from '../../services/tracker';

Page({
  onShow() {
    this.getTabBar?.()?.setData({ selected: 2 });
    track('discover_view', { pageVariant: 'coming_soon' });
  },
});
