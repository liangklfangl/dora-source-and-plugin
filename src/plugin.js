import { parseQuery } from 'loader-utils';
import { join } from 'path';
import isPlainObject from 'is-plain-object';
import resolve from './resolve';
import spmLog from 'spm-log';
import reduceAsync from './reduceAsync';
import isGeneratorFn from 'is-generator-fn';
import co from 'co';

function isRelative(filepath) {
  return filepath.charAt(0) === '.';
}

function isAbsolute(filepath) {
  return filepath.charAt(0) === '/';
}

/*
 (1)传入的配置文件可能是如下类型（还有可能直接是一个字符串）：
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
    字符串的类型是如下方式：
   pluginNames.push(join(__dirname, './plugins/serve-index'));
 (2)require.resolve的查找过程
    简单来说，如果是require('x')这样开头不是相对or绝对地址符号，尾巴也没说是.js或者.json的，就当做模块来找。先找是不是core module，
    然后一级一级向上看node_modules文件夹，每一级的node_modules先看里面是否有basename为所找的文件，再看是否有模块名文件夹下package.json
    的main标明的文件，然后不死心地看看模块名文件夹下有没有index.js和index.node。最后找不到的话，还要搜一遍全局环境，比如$HOME/.node_modules/什么的。
    http://www.cnblogs.com/joyeecheung/p/3941705.html
*/
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
    //如果是一个javascript的plainObject对象，那么其就是插件本身，如上面的require后得到的内容就是一个对象
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

/*
  (1)调用const plugins = resolvePlugins(pluginNames, resolveDir, cwd);
  (2)该方法返回的是一个数组，也就是得到的所有的插件集合,集合中每一个元素的结构如下：
     {
      name,//插件路径
      originQuery,//初始参数
      query,//查询参数对象
      ...plugin,//require文件后得到的对象
    };
*/
export function resolvePlugins(pluginNames, resolveDir, cwd) {
  return pluginNames.map(pluginName => resolvePlugin(pluginName, resolveDir, cwd));
}


/*
   (1)调用方式如下：
     _applyPlugins('middleware.before', null, next)//第一个参数为name，第二个参数为pluginArgs，第三个为_callback
     applyPlugins(plugins, name, context, pluginArgs, _callback);
     其中context如下：
      context={
        get:{},
        set:{},
        applyPlugins:_applyPlugins,
        port:9000,
        cwd:'/cwd',
        app:koa()
      }
  （2)对plugins里面的每一个元素都调用第三个函数，函数参数中：第一个参数为pluginArgs[调用的时候传入的都是null，以后数组中有一个元素执行完这个回调函数后这个memo值都会更新并传入到下一个数组的回调中],第二个参数为demo中的某一个元素
  第三个参数为回调函数，回调后更新我们的pluginArgs为回调的结果。然后取出下一个元素进行同样的操作。在最后一个插件
  调用的时候会执行我们传入的第四个参数并传入我们调用的所有的元素的后的更新的_memo值（每调用一次就会更新一次）
*/
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

    /*
      (1)传入到如'middleware.before'中的回调函数的this对象就是这里的contextModify，他可以进一步修改下面的属性：
         plugins：表示所有的插件的集合，通过dora(config)中的config.plugins获取
         query字段：就是我们在配置插件的时候额外的配置项：
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
       我们在解析后的plugin（plugins中每一个元素都是这种类型）是这样的类型了：
         {
          name,//插件路径
          originQuery,//初始参数
          query,//查询参数对象
          ...plugin,//require文件后得到的对象
        };
       所以不管是对于'middleware.after','middleware.before','server.before'都会有一个函数传入这样的query字段，这个query
       字段《表示在webpack中配置的时候，如doraConfig.plugins中配置插件的时候额外的配置参数》。
       log：可以使用this.debug/info/warn/error来打印消息，第一个参数已经默认存在了是文件名
       callback:通过this.callback来调用，更新我们的_memo值，这个_memo值当下一个插件调用的时候会被传入，所以_memo循环一个元素都会更新一次
       restart：重新启动服务器，通过process.send('restart');koa内部会监控
    */
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
      contextModify.app.use(func.call(contextModify));//每一个middleware也就是如'middleware.before'的函数都会传入工具函数contextModify，middleware不更新_memo
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
    ret = result;
    if (_callback) _callback(err, result);
  });

  // For all sync plugins.
  return ret;
}
