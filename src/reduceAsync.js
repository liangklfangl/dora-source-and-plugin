/*
 (1)调用方式如下：
   reduceAsync(plugins, pluginArgs, (memo, plugin, callback) => {},()=>{})
*/


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

  /*(1)对demo里面的每一个元素都调用第三个函数，函数参数中：第一个参数为pluginArgs,第二个参数为demo中的某一个元素
  第三个参数为回调函数，回调后更新我们的pluginArgs为回调的结果。然后取出下一个元素进行同样的操作。在最后一个插件
  调用的时候会执行我们传入的第四个参数并传入我们调用的所有的元素的后的更新的_memo值（每调用一次就会更新一次）
  */
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
