import resolve from 'resolve';

function tryResolve(id, dirname) {
  let result;
  try {
    result = resolve.sync(id, {
      basedir: dirname,
    });
  } catch (e) {} // eslint-disable-line no-empty
  return result;
}

/*
 (1)调用方式如下：
    resolve(pluginName, resolveDir)
 (2)它会在指定的目录下寻找dora-plugin-name和name插件，如果有那么直接返回
 (3)我们的resolve会从指定的目录开始查找：
    result = resolve.sync(id, {
      basedir: dirname,
    });
    默认是查找node_modules目录
*/
export default function(id, _resolveDir) {
  let resolveDir = _resolveDir;
  if (!Array.isArray(resolveDir)) {
    resolveDir = [resolveDir];
  }

  let result;
  resolveDir.some(dirname => {
    result = tryResolve(`dora-plugin-${id}`, dirname) || tryResolve(id, dirname);
    return result;
  });
  return result;
}
