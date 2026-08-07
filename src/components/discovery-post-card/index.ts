import type { DiscoveryPostPresentation } from '../../utils/discovery-presentation';

Component({
  properties: {
    post: { type: Object, value: {} },
    detailMode: { type: Boolean, value: false },
  },

  methods: {
    openPost() {
      if (this.properties.detailMode) return;
      const post = this.properties.post as unknown as DiscoveryPostPresentation;
      this.triggerEvent('open', { postId: post.postId });
    },

    toggleLike() {
      const post = this.properties.post as unknown as DiscoveryPostPresentation;
      this.triggerEvent('like', {
        postId: post.postId,
        liked: !post.likedByViewer,
      });
    },

    openComments() {
      const post = this.properties.post as unknown as DiscoveryPostPresentation;
      this.triggerEvent('comment', { postId: post.postId });
    },

    openMore() {
      this.triggerEvent('more', { post: this.properties.post as unknown as DiscoveryPostPresentation });
    },

    openRecruitment() {
      const post = this.properties.post as unknown as DiscoveryPostPresentation;
      this.triggerEvent('recruitment', { recruitmentId: post.snapshot.recruitmentId });
    },

    stop() {},
  },
});
