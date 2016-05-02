/**
 * util-request.js - The utilities for requesting script and style files
 * ref: tests/research/load-js-css/test.html
 */
// 如果浏览器支持webworker, 则通过webwoker请求脚本
if (isWebWorker) {
  function requestFromWebWorker(url, callback, charset, crossorigin) {
    // Load with importScripts
    var error
    try {
      importScripts(url) // importScripts为html5的一个API
    } catch (e) {
      error = e
    }
    callback(error)
  }
  // For Developers]
  seajs.request = requestFromWebWorker
}
else {
  var doc = document
  var head = doc.head || doc.getElementsByTagName("head")[0] || doc.documentElement
  var baseElement = head.getElementsByTagName("base")[0]

  var currentlyAddingScript

  function request(url, callback, charset, crossorigin) {
    var node = doc.createElement("script")

    if (charset) {
      node.charset = charset
    }

    if (!isUndefined(crossorigin)) {
      node.setAttribute("crossorigin", crossorigin)
    }

    addOnload(node, callback, url)

    // 创建的是一个异步的script的标签
    node.async = true
    node.src = url

    // For some cache cases in IE 6-8, the script executes IMMEDIATELY after
    // the end of the insert execution, so use `currentlyAddingScript` to
    // hold current node, for deriving url in `define` call
    currentlyAddingScript = node

    // ref: #185 & http://dev.jquery.com/ticket/2709
    // 创建完成后插入到文档中,这个只是暂时插入, 在模块onload之后进行删除
    baseElement ?
        head.insertBefore(node, baseElement) :
        head.appendChild(node)

    currentlyAddingScript = null
  }

  function addOnload(node, callback, url) {
    var supportOnload = "onload" in node

    if (supportOnload) {
      node.onload = onload
      node.onerror = function() {
        emit("error", { uri: url, node: node })
        onload(true)
      }
    }
    else {
      node.onreadystatechange = function() {
        if (/loaded|complete/.test(node.readyState)) {
          onload()
        }
      }
    }

    // 模块onload预示着script已经执行完毕, 此时我们从dom中删除该script节点
    function onload(error) {
      // Ensure only run once and handle memory leak in IE
      node.onload = node.onerror = node.onreadystatechange = null

      // Remove the script to reduce memory leak
      if (!data.debug) {
        // 暂时的插入完成后,
        head.removeChild(node)
      }

      // Dereference the node
      node = null

      callback(error)
    }
  }

  // For Developers
  seajs.request = request

}
