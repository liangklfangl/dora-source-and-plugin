
export default {
  //这里是'middleware'阶段
  middleware() {
    return require('koa-serve-index')(this.cwd, {
      hidden: true,
      view: 'details',
    });
  },
};
