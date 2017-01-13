
export default {
  middleware() {
  	//static静态资源放在this.cwd下
    return require('koa-static')(this.cwd);
  },
};
