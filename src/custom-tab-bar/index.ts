interface PrimaryTabHost {
  changePrimaryTab?: (index: number) => void;
}

Component({
  data: {
    selected: 0,
    hidden: false,
    tabs: [
      { pagePath: '/pages/home/index', text: '首页', icon: '/assets/ui/icons/house.svg' },
      { pagePath: '/pages/memory/index', text: '回忆', icon: '/assets/ui/icons/sparkles.svg' },
      { pagePath: '/pages/discover/index', text: '发现', icon: '/assets/ui/icons/compass.svg' },
      { pagePath: '/pages/profile/index', text: '我的', icon: '/assets/ui/icons/user-round.svg' }
    ]
  },
  methods: {
    switchTab(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const pagePath = event.currentTarget.dataset.path as string;
      if (index === this.data.selected) return;
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1] as unknown as PrimaryTabHost | undefined;
      if (currentPage?.changePrimaryTab) {
        this.setData({ selected: index });
        currentPage.changePrimaryTab(index);
        return;
      }
      this.setData({ selected: index });
      wx.switchTab({ url: pagePath });
    }
  }
});
