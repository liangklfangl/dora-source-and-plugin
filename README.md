#### 1.调用dora(config)后背后的逻辑
(1)合并默认的config和用户自定义的config，其中默认的config如下：
```js
const defaultCwd = process.cwd();
const defaultArgs = {
  port: '8000',
  cwd: defaultCwd,
  enabledMiddlewareServeIndex: true,
  enabledMiddlewareStatic: true,
  resolveDir: [defaultCwd],
};
```

(2)得到所有的插件，并根据用户的shell输入信息更新配置信息
```js
  const pluginNames = args.plugins;
   if (args.enabledMiddlewareStatic) {
    pluginNames.push(join(__dirname, './plugins/static'));
  }
  if (args.enabledMiddlewareServeIndex) {
    pluginNames.push(join(__dirname, './plugins/serve-index'));
  }
```

(3)构建一个context对象，这个对象会原样传入到我们的dora服务器的所有的插件中
```js
 const context = { port, cwd };
  context.set = (key, val) => {
    data[key] = val;
  };
  context.get = key => data[key];
  context.set('__server_listen_log', true);
  function _applyPlugins(name, pluginArgs, _callback) {
  return applyPlugins(plugins, name, context, pluginArgs, _callback);
}
  context.applyPlugins = _applyPlugins;
  log.debug('dora', `[plugins] ${JSON.stringify(plugins)}`);
  const app = context.app = koa();
  context.server=server;//在'middleware.after'后会注册
```

注意，我们的context对象是有get,set,applyPlugins,app,server等属性和方法的。读到这里，我知道你一定的想知道我们的applyPlugins是如何调用的：
```js
 process.on('exit', () => {
    _applyPlugins('process.exit');
  });
```

异步脚本是如下调用的：
```js
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
```

注意一点：中间件注册完毕以后,也就是`'middleware.after'`后,`'server.before'`之前我们才会创建服务器，并将server封装到context的server属性之上！

我们再来看看_applyPlugins真正的代码逻辑是怎么：

`plugins`:表示所有的插件，注册方式可以参见下文

`name`:就是如'middle.before','server.before'等表示执行时机的字符串

`context`:就是我们上面封装的具有各种方法的context对象

`pluginArgs`:表示插件的参数，不过是最初的参数，以后每次执行插件方法都使用了局部变量

`_callback`:回调函数

```js
export function applyPlugins(plugins, name, context, pluginArgs, _callback = function noop() {}) {
  let ret;
  const contextModify = context;
  reduceAsync(plugins, pluginArgs, (memo, plugin, callback) => {
    const func = plugin[name];//name是类似于'middleware.before'这样的字符串
    if (!func) return callback(null, memo);//比如dora-webpack-config中的‘webpack.updateConfig’和‘webpack.updateConfig.finally’
    const log = ['debug', 'info', 'warn', 'error'].reduce((_memo, key) => {
      const m = _memo;//_memo为reduce后面的空对象{}
      m[key] = (msg) => {
        spmLog[key](plugin.name, msg);
      };
      return m;
    }, {});
    // Add more context api
    contextModify.plugins = plugins;
    contextModify.query = plugin.query;
    contextModify.log = log;
    contextModify.callback = callback;
    contextModify.restart = () => {
      console.log();
      spmLog.info('dora', 'try to restart...');
      process.send('restart');
    };
    //这个在组件dora-plugin-webpack中通过this.restart()调用，当监听到package.json变化都就调用
    if (name === 'middleware') {
      contextModify.app.use(func.call(contextModify));
      //每一个middleware也就是如'middleware.before'的函数都会传入工具函数contextModify，middleware不更新_memo
      callback();
      //如果是Generator函数，异步函数同步化
    } else if (isGeneratorFn(func)) {
      co.wrap(func).call(contextModify).then((val) => {
        callback(null, val);
      }, callback);
      //then函数接受两个回调函数
    } else {
      //否则传入contextModify参数和memo
      const funcResult = func.call(contextModify, memo);
      if (funcResult && funcResult.then) {
        funcResult
        .then(result => {
          callback(null, result);
        })
        .catch(callback)
        .catch(err => {
          throw new Error(err);
        });
      } else {
        callback(null, funcResult);
      }
    }
  }, (err, result) => {
   //这是reduceAsync的第四个回调函数，但是是在所有数组元素遍历结束后调用
    ret = result;
    if (_callback) _callback(err, result);
  });
  return ret;
}
```

现在对我们这里的applyPlugins做进一步的分析：

*传入到如'middleware.before'中的回调函数的this对象就是这里的contextModify，他可以进一步修改下面的属性：*

`.`plugins：表示所有的插件的集合，通过dora(config)中的config.plugins配置的

`.`query字段：就是我们在配置插件的时候额外的配置项。所以不管是对于'middleware.after',
         'middleware.before','server.before'都会有一个函数传入这样的query字段，这个query字段表示在webpack中配置的时候，如doraConfig.plugins中配置插件的时候额外的配置参数

`.`log：可以使用this.debug/info/warn/error来打印消息，第一个参数已经默认存在了是文件名

`.`callback:通过this.callback来调用，更新我们的_memo值，这个_memo值当下一个插件调用的
            时候会被传入，所以_memo循环一个元素都会更新一次
            
`restart`：重新启动服务器，通过process.send('restart');koa内部会监控

到了这里我们必须要分析一下reduceAsync方法才行：

```js
export default function reduceAsync(arr, memo, iterator, callback) {
  let _memo = memo;
  let index = 0;
  function next() {
    index = index + 1;
    if (arr[index]) {
      return run(arr[index]);  // eslint-disable-line no-use-before-define
    }
    if (callback) callback(null, _memo);
    return _memo;
  }
  function run(item) {
    iterator(_memo, item, (err, result) => {
      if (err) {
        throw new Error(err);
      }
      _memo = result;
      next();
    });
  }
  return run(arr[index]);
}
```

分析：
首先：对arr中每一个元素都执行第三个回调函数，该函数中第一个参数是一个遍历所有的数组元素共有的一个全局遍历_memo，第二个参数就是数组中的每一个元素，第三个函数是一个回调函数，回调函数中会每次更新_memo的值！同时reduceAsync的第二个参数就是我们说的_memo的初始值！

然后：如果数组中的每一个元素都被遍历结束了，那么我们就会把结果_memo传给最后的回调函数，也就是我们调用reduceAsync传入的第四个函数。

那么对于上面的applyPlugins那么肯定就很好理解了：
```js
reduceAsync(plugins, pluginArgs, (memo, plugin, callback) => {
    const func = plugin[name];//name是类似于'middleware.before'这样的字符串
    if (!func) return callback(null, memo);//比如dora-webpack-config中的‘webpack.updateConfig’和‘webpack.updateConfig.finally’
    const log = ['debug', 'info', 'warn', 'error'].reduce((_memo, key) => {
      const m = _memo;//_memo为reduce后面的空对象{}
      m[key] = (msg) => {
        spmLog[key](plugin.name, msg);
      };
      return m;
    }, {});
    // Add more context api
    contextModify.plugins = plugins;
    contextModify.query = plugin.query;
    contextModify.log = log;
    contextModify.callback = callback;
    contextModify.restart = () => {
      console.log();
      spmLog.info('dora', 'try to restart...');
      process.send('restart');
    };
    //这个在组件dora-plugin-webpack中通过this.restart()调用，当监听到package.json变化都就调用
    if (name === 'middleware') {
      contextModify.app.use(func.call(contextModify));
      //每一个middleware也就是如'middleware.before'的函数都会传入工具函数contextModify，middleware不更新_memo
      callback();
      //如果是Generator函数，异步函数同步化
    } else if (isGeneratorFn(func)) {
      co.wrap(func).call(contextModify).then((val) => {
        callback(null, val);
      }, callback);
      //then函数接受两个回调函数
    } else {
      //否则传入contextModify参数和memo
      const funcResult = func.call(contextModify, memo);
      if (funcResult && funcResult.then) {
        funcResult
        .then(result => {
          callback(null, result);
        })
        .catch(callback)
        .catch(err => {
          throw new Error(err);
        });
      } else {
        callback(null, funcResult);
      }
    }
  })
```

比如我们要执行middleware.before中的插件：
```js
_applyPlugins('middleware.before', null, next)
```

那么其实我们是遍历所有的插件集合,看这个插件有没有这个方法，如果有那么我们就拿到这个函数
```js
  const func = plugin[name];//name是类似于'middleware.before'这样的字符串
```

注意，根据后面的分析，我们的plugin其实是下面这种类型，所以你就很好理解了，因为plugin就是我们的插件的内容

```js
 return {
    name,//插件路径
    originQuery,//初始参数
    query,//查询参数对象
    ...plugin,//require文件后得到的对象
  };
```

虽然我们拿到了这个函数，但是我们要看看我们什么时候执行这个函数以及如何执行的：
```js
   if (name === 'middleware') {
      contextModify.app.use(func.call(contextModify));
      callback();
      //如果是Generator函数，异步函数同步化
    } else if (isGeneratorFn(func)) {
      co.wrap(func).call(contextModify).then((val) => {
        callback(null, val);
      }, callback);
      //then函数接受两个回调函数
    } else {
      //否则传入contextModify参数和memo
      const funcResult = func.call(contextModify, memo);
      if (funcResult && funcResult.then) {
        funcResult
        .then(result => {
          callback(null, result);
        })
        .catch(callback)
        .catch(err => {
          throw new Error(err);
        });
      } else {
        callback(null, funcResult);
      }
    }
```

如果是需要执行`middleware`中的回调函数：

```js
if (name === 'middleware') {
      contextModify.app.use(func.call(contextModify));
      callback();
      //如果是Generator函数，异步函数同步化
    } 
```

很显然，对于插件middleware的回调函数，其实我们是直接koa服务器的use参数，即插件来调用的，不同在这个函数中我们会传入我们构建的context对象。
```js
 const app = context.app = koa();
```

如果是Generator函数，那么我们如下执行:
```js
  else if (isGeneratorFn(func)) {
      co.wrap(func).call(contextModify).then((val) => {
        callback(null, val);
      }, callback);
      //then函数接受两个回调函数
    } 
```

因为Generator常常适用于异步执行的同步化，所以我们会通过co来处理，并进行相应的then回调。如果不是上面任意种类型：
```js
    else {
      //否则传入contextModify参数和memo
      const funcResult = func.call(contextModify, memo);
      if (funcResult && funcResult.then) {
        funcResult
        .then(result => {
          callback(null, result);
        })
        .catch(callback)
        .catch(err => {
          throw new Error(err);
        });
      } else {
        callback(null, funcResult);
      }
    }
```

注意：在这里我们直接是调用这个插件返回的函数，如`server.before`返回的函数，同时也会封装我们的context对象,你`必须注意`,这里为每一个函数func封装的memo是到当前这个插件调用结束后得到的这个值，因为这里的memo其实是为reduceAsync第三个参数封装的memo值！

```js
function run(item) {
    iterator(_memo, item, (err, result) => {
      if (err) {
        throw new Error(err);
      }
      _memo = result;
      next();
    });
  }
```

也就是上面的这个_memo参数，而这个参数是每一个插件调用一次都会更新的。上面总共提到了func有三种情况，每种情况结束后，我们调用一次callback，这个callback不是给reduceAync传入的第四个参数，而是给我们的reduceAsync的第三个参数传入的callback，这个callback的作用是用于更新到本次调用结束我们的reduceAsync的第二个参数的值，其实就是_memo这个局部变量。即调用的是：

```js
(err, result) => {
      if (err) {
        throw new Error(err);
      }
      _memo = result;
      next();
    }
```

那么你可能会问，那么我们传入的reduceAysnc第四个参数什么时候会回调的？
```js
function next() {
    index = index + 1;
    if (arr[index]) {
      return run(arr[index]);  // eslint-disable-line no-use-before-define
    }
    if (callback) callback(null, _memo);
    return _memo;
  }
```

很显然，*我们传入到reduceAync的第四个回调会当第一个参数数组中所有的插件都遍历完成后才会回调（回调的时候会传入所有的插件都调用结束后最终的memo，而不是当前插件调用结束的memo）;而传入reduceAync的第三个函数每次都会回调，每次回调的时候第一个参数就是执行到当前插件时候memo的值，而第二个参数就是当前plugin，而第三个参数的回调就是为了更新当前的memo值*。

(4)对插件进行解析
```js
  const plugins = resolvePlugins(pluginNames, resolveDir, cwd);
```

```js
export function resolvePlugins(pluginNames, resolveDir, cwd) {
  return pluginNames.map(pluginName => resolvePlugin(pluginName, resolveDir, cwd));
}
```

很显然，我们的方法是对所有的插件进行单独的解析，我们看看我们配置的插件都是有什么类型？注意：下面这段代码来自于bisheng.js
```js
const doraConfig = Object.assign({}, {
    cwd: path.join(process.cwd(), config.output),
    port: config.port,
  }, config.doraConfig);
  doraConfig.plugins = [
    [require.resolve('dora-plugin-webpack'), {
      disableNpmInstall: true,
      cwd: process.cwd(),
      config: 'bisheng-inexistent.config.js',
    }],
    [path.join(__dirname, 'dora-plugin-bisheng'), {
      config: configFile,
    }],
    require.resolve('dora-plugin-browser-history'),
  ];
  const usersDoraPlugin = config.doraConfig.plugins || [];
  doraConfig.plugins = doraConfig.plugins.concat(usersDoraPlugin);
  if (program.livereload) {
    doraConfig.plugins.push(require.resolve('dora-plugin-livereload'));
  }
  dora(doraConfig);
```

很显然，我们配置的插件有可能是数组：
```js
[require.resolve('dora-plugin-webpack'), {
      disableNpmInstall: true,
      cwd: process.cwd(),
      config: 'bisheng-inexistent.config.js',
    }]
```

还有可能是字符串（上面已经见过了）:
```js
 if (args.enabledMiddlewareServeIndex) {
    pluginNames.push(join(__dirname, './plugins/serve-index'));
  }
```

也有可能是一个object对象，如下:
```js
 require.resolve('dora-plugin-browser-history'),
```

我们再来看看resolvePlugin方法：
```js
export function resolvePlugin(_pluginName, resolveDir, cwd = process.cwd()) {
  let plugin;
  let query = {};
  let originQuery;
  let name;
  if (typeof _pluginName === 'string') {
    const [pluginName, _query] = _pluginName.split('?');
    if (_query) {
      originQuery = `?${_query}`;
      query = parseQuery(originQuery);
    }
    name = pluginName;
    if (isRelative(pluginName)) {
      plugin = require(join(cwd, pluginName));
    } else if (isAbsolute(pluginName)) {
      plugin = require(pluginName);
    } else {
      // is Module
      const pluginPath = resolve(pluginName, resolveDir);
      if (!pluginPath) {
        throw new Error(`[Error] ${pluginName} not found in ${resolveDir}`);
      }
      plugin = require(pluginPath);
    }
  } else if (isPlainObject(_pluginName)) {
    plugin = _pluginName;
  } else if (Array.isArray(_pluginName)) {
    //如果是数组，第一个参数是插件名称，第二个参数是查询字符串
    name = _pluginName[0];
    query = _pluginName[1];
    const pluginPath = resolve(name, resolveDir);
    if (!pluginPath) {
      throw new Error(`[Error] ${name} not found in ${resolveDir}`);
    }
    plugin = require(pluginPath);
  } else {
    throw Error('[Error] pluginName must be string or object or [string, object]');
  }
  return {
    name,//插件路径
    originQuery,//初始参数
    query,//查询参数对象
    ...plugin,//require文件后得到的对象
  };
}
```

是不是很简单呢？如果是字符串类型，那么如下处理：
```js
if (typeof _pluginName === 'string') {
    const [pluginName, _query] = _pluginName.split('?');
    if (_query) {
      originQuery = `?${_query}`;
      query = parseQuery(originQuery);
    }
    name = pluginName;
    if (isRelative(pluginName)) {
      plugin = require(join(cwd, pluginName));
    } else if (isAbsolute(pluginName)) {
      plugin = require(pluginName);
    } else {
      // is Module
      const pluginPath = resolve(pluginName, resolveDir);
      if (!pluginPath) {
        throw new Error(`[Error] ${pluginName} not found in ${resolveDir}`);
      }
      plugin = require(pluginPath);
    }
  }
```

这时候会有以下几点要注意：

`.`插件的名称name就是文件的路径

`.`originQuery就是?${_query_}这种字符串

`.`query就是解析后的参数

`.`最重要的就是plugin的内容，如果是文件那么我们直接获取到这对象(不管是相对路径还是绝对路径)。
   如果不是路径，那么我们解析出来这个插件的路径，可能会顺着node_modules查找并引入进来，所以我们得到的是这个模块的内容。对于后面的Rest运算符，我这里给出说明的用法：

```js
var obj={name:'liangklfang',sex:'male'};
var out={location:'HangZhou',...obj}
console.log(out);
```

此时我们的out就会是下面的类型：

```js
Object {
  "location": "HangZhou",
  "name": "liangklfang",
  "sex": "male"
}
```

但是要注意，如果你直接采用"...obj"，而不是直接在对象里面那么是会报错的。上面讲到了是string的情况，那么如果是对象，那么表示直接是我们的插件plugin对象了：
```js
else if (isPlainObject(_pluginName)) {
    plugin = _pluginName;//对象就是插件本身
  } 
```

上面讲到了还有可能是数组，而且在上面也演示了是数组的情况：
```js
else if (Array.isArray(_pluginName)) {
    name = _pluginName[0];
    query = _pluginName[1];
    const pluginPath = resolve(name, resolveDir);
    if (!pluginPath) {
      throw new Error(`[Error] ${name} not found in ${resolveDir}`);
    }
    plugin = require(pluginPath);
  } else {
    throw Error('[Error] pluginName must be string or object or [string, object]');
  }
```

我再重复粘贴一下上面的数组配置你肯定就不要我分析了：
```js
[require.resolve('dora-plugin-webpack'), {
      disableNpmInstall: true,
      cwd: process.cwd(),
      config: 'bisheng-inexistent.config.js',
    }]
```

也就是说数组中第一个对象是我们的plugin，而第二个参数就是我们的query字段！

#### 2.如何写dora插件
2.1:dora-plugin-webpack

首先我想分析下我们的dora-plugin-webpack，通过它来熟悉我们上面的dora源码分析部分。如下是该插件的源码：
```js
import mergeCustomConfig from 'atool-build/lib/mergeCustomConfig';
import getWebpackCommonConfig from 'atool-build/lib/getWebpackCommonConfig';
import webpack, { ProgressPlugin } from 'atool-build/lib/webpack';
import { join, resolve } from 'path';
import chalk from 'chalk';
import chokidar from 'chokidar';
//A neat wrapper around node.js fs.watch / fs.watchFile / fsevents.
import NpmInstallPlugin from 'npm-install-webpack-plugin-cn';
//Speed up development by automatically installing & saving dependencies with Webpack.
import isEqual from 'lodash.isequal';
import { readFileSync, existsSync } from 'fs';
let webpackConfig;
export default {
  name: 'dora-plugin-webpack',
  'middleware.before'() {
    const { applyPlugins, query } = this;
    let { cwd } = this;
    if (query.cwd) {
      cwd = query.cwd;
    }
    const customConfigPath = resolve(cwd, query.config || 'webpack.config.js');
    if (existsSync(customConfigPath)) {
      const customConfig = require(customConfigPath);
      // Support native webpack
      if (typeof customConfig === 'object') {
        webpackConfig = customConfig;
        return;
      }
    }
    webpackConfig = getWebpackCommonConfig({ ...this, cwd });
    webpackConfig.devtool = '#cheap-module-source-map';
    //设置sourceMap
    webpackConfig.plugins = webpackConfig.plugins.concat([
      new ProgressPlugin((percentage, msg) => {
        const stream = process.stderr;//进程错误信息
        if (stream.isTTY && percentage < 0.71 && this.get('__ready')) {
          stream.cursorTo(0);
          stream.write('📦  ' + chalk.magenta(msg));//品红色
          stream.clearLine(1);
        } else if (percentage === 1) {
          //如果进度是100%，那么打印结果
          console.log(chalk.green('\nwebpack: bundle build is now finished.'));
        }
      }),
    ]);
    //添加NpmInstallPlugin插件，save为true表示是生产环境
    if (!query.disableNpmInstall) {
      webpackConfig.plugins.push(new NpmInstallPlugin({
        save: true,
      }));
    }
    webpackConfig = applyPlugins('webpack.updateConfig', webpackConfig);
    webpackConfig = mergeCustomConfig(webpackConfig, customConfigPath, 'development');
    //自定义webpack配置和继承来的webpack配置合并
    webpackConfig = applyPlugins('webpack.updateConfig.finally', webpackConfig);
    //更新output.publicPath
    if (query.publicPath) {
      webpackConfig.output.publicPath = query.publicPath;
    }
    if (!query.publicPath && webpackConfig.output.publicPath) {
      query.publicPath = webpackConfig.output.publicPath;
    }
  },
  'middleware'() {
    const { verbose, physcisFileSystem } = this.query;
    const compiler = webpack(webpackConfig);
    this.set('compiler', compiler);
    //设置编译器compiler
    compiler.plugin('done', function doneHandler(stats) {
      if (verbose || stats.hasErrors()) {
        console.log(stats.toString({colors: true}));
      }
    });
    //verbose表示是否打印调试信息
    if (physcisFileSystem) {
      const outputFileSystem = compiler.outputFileSystem;
      setTimeout(() => {
        compiler.outputFileSystem = outputFileSystem;
      }, 0);
    }
    return require('koa-webpack-dev-middleware')(compiler, {
      publicPath: '/',//public path to bind the middleware to
      quiet: true,//display nothing to the console
      ...this.query,
    });
  },
  'server.after'() {
    const { query } = this;
    let { cwd } = this;
    if (query.cwd) {
      cwd = query.cwd;
    }
    const pkgPath = join(cwd, 'package.json');
    //获取package.json路径
    function getEntry() {
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).entry;
      } catch (e) {
        return null;
      }
    }
    const entry = getEntry();
    chokidar.watch(pkgPath).on('change', () => {
      if (!isEqual(getEntry(), entry)) {
        this.restart();
      }
    });
    const webpackConfigPath = resolve(cwd, query.config || 'webpack.config.js');
    chokidar.watch(webpackConfigPath).on('change', () => {
      this.restart();
    });
  },
};
```

该插件注册了'middleware.before','middleware', 'server.after'等服务器运行时期的句柄，我们首先分析下我们的'middleware.before'部分：

```js
'middleware.before'() {
    const { applyPlugins, query } = this;
    //上面已经说过了运行回调函数后会封装我们的context对象，这些方法都在context中
    let { cwd } = this;
    //代码const context = { port, cwd };
    if (query.cwd) {
      cwd = query.cwd;
    }
    //query是插件提供的query，如果插件本身提供了cwd那么用插件的cwd，这的resolve会不断
    //查询node_modules
    const customConfigPath = resolve(cwd, query.config || 'webpack.config.js');
    //如果配置了webpack.config.js那么我们获取内容，如果是一个object，那么其就是webpackConfig对象
    if (existsSync(customConfigPath)) {
      const customConfig = require(customConfigPath);
      // Support native webpack
      if (typeof customConfig === 'object') {
        webpackConfig = customConfig;
        return;
      }
    }
    //获取到了我们的webpack.config.js内容
    webpackConfig = getWebpackCommonConfig({ ...this, cwd });
    //获取webpack的基本配置信息并传入我们的this也就是context对象,context提供的信息
    //我们在上面已经说过了，包括cwd,query,get,set,app,server,plugins,callback,log等
    webpackConfig.devtool = '#cheap-module-source-map';
    //设置sourceMap
    webpackConfig.plugins = webpackConfig.plugins.concat([
      new ProgressPlugin((percentage, msg) => {
        const stream = process.stderr;//进程错误信息
        if (stream.isTTY && percentage < 0.71 && this.get('__ready')) {
          stream.cursorTo(0);
          stream.write('📦  ' + chalk.magenta(msg));//品红色
          stream.clearLine(1);
        } else if (percentage === 1) {
          //如果进度是100%，那么打印结果
          console.log(chalk.green('\nwebpack: bundle build is now finished.'));
        }
      }),
    ]);
    //添加NpmInstallPlugin插件，save为true表示是生产环境
    if (!query.disableNpmInstall) {
      webpackConfig.plugins.push(new NpmInstallPlugin({
        save: true,
      }));
    }
    webpackConfig = applyPlugins('webpack.updateConfig', webpackConfig);
    //那么这个插件就必须自己处理webpackConfig对象，表示我们注册了一个插件，插件监测的是'webpack.updateConfig'，这个webpackConfig值会传入这个插件，因为在dora内部callback(null, result);其中result就是遍历每一个插件的时候传入这个值webpackConfig。其中applyPlugins返回的对象就是 ret = result;也就是调用所有插件后返回的_memo_值,是对pluginArgs进行了所有的处理后得到的结果
    webpackConfig = mergeCustomConfig(webpackConfig, customConfigPath, 'development');
    //自定义webpack配置和继承来的webpack配置合并
    webpackConfig = applyPlugins('webpack.updateConfig.finally', webpackConfig);
    //更新output.publicPath
    if (query.publicPath) {
      webpackConfig.output.publicPath = query.publicPath;
    }
    if (!query.publicPath && webpackConfig.output.publicPath) {
      query.publicPath = webpackConfig.output.publicPath;
    }
  }
```

其中上面的mergeCustomConfig就是对webpack的配置进行合并，如下：
```js
export default function mergeCustomConfig(webpackConfig, customConfigPath) {
  if (!existsSync(customConfigPath)) {
    return webpackConfig;
  }
  const customConfig = require(customConfigPath);
  if (typeof customConfig === 'function') {
    return customConfig(webpackConfig, ...[...arguments].slice(2));
  }
  throw new Error(`Return of ${customConfigPath} must be a function.`);
}
```

也就是说，我们的获取到自己的webpack.config.js并获取到这个对象，该对象必须是一个导出的一个函数，我们调用这个函数并传入我们的webpackConfig对象和额外的参数!注意，*这个函数的用处在在于，我们的指定的配置文件，如webpack.config.js导出的必须是一个函数的情况*！

通过上面的分析，我们在`middleware.before`中做了如下的规定：

`首先`：我们获取用户自己配置的webpack.config.js文件。但是这里我有一点没弄懂，如下：
```js
const customConfigPath = resolve(cwd, query.config || 'webpack.config.js');
    if (existsSync(customConfigPath)) {
      const customConfig = require(customConfigPath);
      // Support native webpack
      if (typeof customConfig === 'object') {
        webpackConfig = customConfig;
        return;
      }
    }
    webpackConfig = getWebpackCommonConfig({ ...this, cwd });
```

也就是说，如果我们的webpack.config.js返回的是一个object，那么后面的通过getWebpackCommonConfig获取到的配置不是会覆盖以前的webpack对象吗？

`然后`：如果我们要注册插件来修改webpack配置，那么可以在`webpack.updateConfig`和`webpack.updateConfig.finally`中来修改，这个函数会被传入我们的webpackConfig对象来提供给使用者,如下面这种方式：

```js
module.exports = {
  'webpack.updateConfig'(webpackConfig) {
    return updateWebpackConfig(webpackConfig, this.query.config);
    //就是根据我们的config文件来更新我们的webpackConfig对象
  },
};
```

最后，总结一下，我们在`middleware.before`中做的事情就是获取到我们webpack的配置文件并加入一下插件而已，并提供了修改webpack配置的两个钩子函数，如第二点。从下面的执行时机来说，我们此时的koa服务器都没有启动：
```js
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
```

接下来我们分析下"middleware"时机：

```js
'middleware'() {
    const { verbose, physcisFileSystem } = this.query;
    //判断我们配置我们的dora-plugin-webpack插件时候是否配置了verbose
    const compiler = webpack(webpackConfig);
    this.set('compiler', compiler);
    //context设置了编译器compiler
    compiler.plugin('done', function doneHandler(stats) {
      if (verbose || stats.hasErrors()) {
        console.log(stats.toString({colors: true}));
      }
    });
    //‘done’时机表示所有的资源已经编译完毕,verbose表示是否打印调试信息
    //如果配置我们的dora-plugin-webpack插件使用了physcisFileSystem参数
    if (physcisFileSystem) {
      const outputFileSystem = compiler.outputFileSystem;
      setTimeout(() => {
        compiler.outputFileSystem = outputFileSystem;
      }, 0);
    }
    return require('koa-webpack-dev-middleware')(compiler, {
      publicPath: '/',//public path to bind the middleware to
      quiet: true,//display nothing to the console
      ...this.query,
    });
  },
```

注意：我们的`middleware`时机必须返回一个middleware才行，这里返回的是[koa-webpack-dev-middleware](https://github.com/yiminghe/koa-webpack-dev-middleware),他是[webpack-dev-server](https://github.com/webpack/webpack-dev-middleware)的koa版本，作用如下：

It's a simple wrapper middleware for webpack. It *serves the files emitted from webpack over a connect server*.

It has a few advantages over bundling it as files:

No files are written to disk, it handle the files in memory

If files changed in watch mode, the middleware no longer serves the old bundle, but delays requests until the compiling has finished. You don't have to wait before refreshing the page after a file modification.
I may add some specific optimization in future releases.

那么上面还有一段代码有什么用呢?
```js
if (physcisFileSystem) {
      const outputFileSystem = compiler.outputFileSystem;
      setTimeout(() => {
        compiler.outputFileSystem = outputFileSystem;
      }, 0);
    }
```

作用：默认的情况下，构建好的目录一定要输出到某个目录下面才能使用，但webpack 提供了一种很棒的读写机制，使得我们可以直接在内存中进行读写，从而极大地提高 IO 的效率，开启的方法也很简单。
```js
var MemoryFS = require("memory-fs");
var webpack = require("webpack");
var fs = new MemoryFS();
var compiler = webpack({ ... });
compiler.outputFileSystem = fs;
compiler.run(function(err, stats) {
  // ...
  var fileContent = fs.readFileSync("...");
});
```

那么这里的作用应该也是一样的！具体可以参考文末参考文献,你也可以查看[这个issue](https://github.com/webpack/webpack-dev-middleware/issues/125),不过现在应该不用判断physcisFileSystem了，因为MultiCompiler的问题已经修复了。对于'middleware'阶段来说，我们其实还没有启动服务器的，所以我们只是添加了一个webpack的中间件。从上面说的执行时机来说，我们此时也没有启动服务器，但是我们此时的webpackConfig已经是完整的了，而且在`middleware`阶段我们已经手动调用webpack方法开始编译，并得到我们的compiler对象，同时设置了webpack吐出的文件直接给我们的server这个koa中间件（`此阶段主要用于注册koa中间件`）！

我们再来看看`server.after`中的回调函数：
```js
'server.after'() {
    const { query } = this;
    let { cwd } = this;
    if (query.cwd) {
      cwd = query.cwd;
    }
    const pkgPath = join(cwd, 'package.json');
    //获取package.json路径
    function getEntry() {
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8')).entry;
      } catch (e) {
        return null;
      }
    }
    const entry = getEntry();
    //读取package.json中的entry内容,并监听change事件，如果文件内容发生了变化那么我们直接调用restart方法
    chokidar.watch(pkgPath).on('change', () => {
      if (!isEqual(getEntry(), entry)) {
        this.restart();
      }
    });
    //监听根目录下的webpack.config.js变化都也重启服务器
    const webpackConfigPath = resolve(cwd, query.config || 'webpack.config.js');
    chokidar.watch(webpackConfigPath).on('change', () => {
      this.restart();
    });
  }
```

注意，在server服务器启动之后，我们会监听package.json和webpack.config.js文件的变化，如果文件变化了那么我们会`重启koa服务器`！

总之：dora-plugin-webpack可以让你配置webpack配置，但是同时也提供了钩子函数可以让你修改webpack的配置;同时也可以使用koa-webpack-dev-middleware是的我们的server可以从内存中读取文件，而不用把文件写出到硬盘中;在'server.after'中，我们会监听package.json和webpack配置文件的变化从而重启服务器！我们总结下这个插件提到的三个阶段：

`'middleware.before'`：得到webpack最终配置，并提供了两个钩子来修改webpack配置,分别为'webpack.updateConfig','webpack.updateConfig.finally'

`middleware`:手动调用webpack进行文件编译得到compiler对象，并指定了webpack静态文件吐出后的服务器

`'server.after'`:此时server已经启动了，我们监听package.json和webpack.config.js文件的变化

2.2 dora-plugin-browser-history

 下面是这个插件的源码：
```js
module.exports = {
  'middleware': function() {
    var query = this.query;
    var middleware = require('connect-history-api-fallback')({
      index: query.index || '/index.html',
      rewrites: query.rewrites,
    });

    var noop = function() {};

    return function* (next) {
      middleware(this, null, noop);
      yield next;
    };
  },
};
```

很显然，这个插件是注册到'middleware'中的，也就是通过app.use这种形式注册的：
```js
if (name === 'middleware') {
      contextModify.app.use(func.call(contextModify));
      callback();
    }
```

`middleware`注册的回调可以处理网络请求，而且还有申明下`middleware`是必须返回一个koa中间件的！这里返回的是'connect-history-api-fallback':
,具体用法可以参考[这里](https://github.com/liangklfang/connect-history-api-fallback)

到这里我就不在分析其他的插件了，如果你感兴趣可以查看文末的参考文献继续学习这方面的内容。




参考文献：

[dora服务器](http://ant-tool.github.io/dora.html)

[dora仓库](https://github.com/dora-js/dora)

[dora-plugin-webpack](https://github.com/dora-js/dora-plugin-webpack)

[webpack-compiler-and-compilation](https://github.com/liangklfangl/webpack-compiler-and-compilation)

[开发工具心得：如何 10 倍提高你的 WEBPACK 构建效率](http://hao.jser.com/archive/10861/)

[webpack-dev-middleware](https://github.com/webpack/webpack-dev-middleware)

[dora 插件机制简介](https://github.com/dora-js/dora/blob/master/docs/Understand-Dora-Plugin.md)




















