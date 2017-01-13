import http from 'http';
import koa from 'koa';
import { resolvePlugins, applyPlugins } from './plugin';
import log from 'spm-log';
import async from 'async';
import { join } from 'path';

const defaultCwd = process.cwd();
//获取进程目录
const defaultArgs = {
  port: '8000',
  cwd: defaultCwd,
  enabledMiddlewareServeIndex: true,
  enabledMiddlewareStatic: true,
  resolveDir: [defaultCwd],
  //要查看的路径，是一个数组,会在这个路径下查看我们的模块
};
const data = {};

/*
(1)调用方式如下：
    dora(doraConfig);
*/
export default function createServer(_args, callback) {
  const args = { ...defaultArgs, ..._args };
  log.config(args);

  const { port, cwd, resolveDir } = args;
  //获取port, cwd, resolveDir参数

  const pluginNames = args.plugins;
  //获取所有的插件plugins

  const context = { port, cwd };
  //port和cwd构成context,context={port: "8000", cwd: "/cwd"}

  context.set = (key, val) => {
    data[key] = val;
  };
  context.get = key => data[key];
  context.set('__server_listen_log', true);

  //添加静态文件插件
  if (args.enabledMiddlewareStatic) {
    pluginNames.push(join(__dirname, './plugins/static'));
  }
  //添加server-index插件
  if (args.enabledMiddlewareServeIndex) {
    pluginNames.push(join(__dirname, './plugins/serve-index'));
  }

  const plugins = resolvePlugins(pluginNames, resolveDir, cwd);
   //得到所有插件

   //调用方式如下：_applyPlugins('middleware.before', null, next)
   //在dora-webpack-plugin中调用：_applyPlugins('webpack.updateConfig',webpackConfig)
  function _applyPlugins(name, pluginArgs, _callback) {
    return applyPlugins(plugins, name, context, pluginArgs, _callback);
  }
  context.applyPlugins = _applyPlugins;
  //为context添加一个applyPlugins函数

  log.debug('dora', `[plugins] ${JSON.stringify(plugins)}`);

  const app = context.app = koa();
  //context.app是koa服务器

  let server;

  process.on('exit', () => {
    _applyPlugins('process.exit');
  });

  async.series([
    next => _applyPlugins('middleware.before', null, next),
    next => _applyPlugins('middleware', null, next),
    next => _applyPlugins('middleware.after', null, next),
    //中间件注册完毕以后,也就是'middleware.after'后我们才会创建服务器，并将server封装到context的server属性之上
    next => { server = context.server = http.createServer(app.callback()); next(); },
    next => _applyPlugins('server.before', null, next),
    next => {
      server.listen(port, () => {
        if (context.get('__server_listen_log')) {
          log.info('dora', `listened on ${port}`);
        }
        context.set('__ready', true);
        //为context设置一个__reay属性为true
        next();
      });
    },
    next => _applyPlugins('server.after', null, next),
    //服务器注册完毕以后，也就是在'server.after'后，我们会执行所有的插件
  ], callback);
}
