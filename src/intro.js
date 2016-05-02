/**
 * Sea.js @VERSION | seajs.org/LICENSE.md
 */
// 类似jquery, 将全局对象缓存到局部变量,提高全局对象的操作效率
// 修正undefined, 考虑到undefined可能在外部被篡改了
(function(global, undefined) {

// Avoid conflicting when `sea.js` is loaded multiple times
if (global.seajs) {
  return
}
