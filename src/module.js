/**
 * module.js - The core of module loader
 */

// 以下涉及到的事件分派主要交给seajs的插件完成,

// 用一个缓存对象来缓存模块, 各个模块以其uri进行标识
var cachedMods = seajs.cache = {}

// 标识当前请求的模块是否是一个匿名模块
var anonymousMeta

// 获取中队列：标识哪些uri正在被获取
var fetchingList = {}

// 已获取队列：标识已获取到的uri
var fetchedList = {}

// 回调队列, 当中暂存了模块对象，一旦模块加载完毕，
// 将会从callbackList取出，以其为树根，加载模块子树
var callbackList = {}

// sea定义的几个模块加载状态
var STATUS = Module.STATUS = {
  // 1 - The `module.uri` is being fetched
  FETCHING: 1, // 获取模块中
  // 2 - The meta data has been saved to cachedMods
  SAVED: 2, // 模块的元信息已经被存入了缓存
  // 3 - The `module.dependencies` are being loaded
  LOADING: 3, // 加载模块的依赖
  // 4 - The module are ready to execute
  LOADED: 4, // 模块所有的依赖都被加载, 因此模块即将被执行
  // 5 - The module is being executed
  EXECUTING: 5, // 模块执行中
  // 6 - The `module.exports` is available
  EXECUTED: 6, // 模块执行完毕,相应的外部接口暴露完毕
  // 7 - 404
  ERROR: 7
}

// 模块的构造函数, 主要是初始该模块的一些信息
function Module(uri, deps) {
  this.uri = uri // 模块地址

  this.dependencies = deps || [] // 模块的相应依赖项,保存的是依赖id

  this.deps = {} // 模块的依赖,保存的是依赖的模块的引用

  this.status = 0 // 模块的加载状况

  this._entry = [] // 模块的入口列表
}

/**
 * 从当前模块的依赖id序列中中解析出其依赖的真是资源地址uri
 * @returns {Array}
 */
Module.prototype.resolve = function() {
  var mod = this
  var ids = mod.dependencies
  var uris = []

  for (var i = 0, len = ids.length; i < len; i++) {
    uris[i] = Module.resolve(ids[i], mod.uri)
  }
  return uris
}

/**
 * 设置依赖的入口
 * 最终
 * use中的匿名模块anonymous的入口: []
 * 其依赖main的入口: [anonymous, main]
 * main的依赖项hello-printer入口：[anonymous,]
 * main的依赖项world-printer入口：[anonymous,]
 */
Module.prototype.pass = function() {
  var mod = this

  var len = mod.dependencies.length

  // 遍历模块的各个入口
  for (var i = 0; i < mod._entry.length; i++) {
    var entry = mod._entry[i]
    var count = 0
    // 遍历模块的各个依赖
    for (var j = 0; j < len; j++) {
      var m = mod.deps[mod.dependencies[j]]
      // 如果该依赖尚未加载完毕, 并且没有在entry的遍历历史中记录
      // 则将入口pass给依赖，这样，逐层的传递依赖直到叶子节点
      // 显然，应当从不再具有依赖的叶子节点回溯
      // If the module is unload and unused in the entry, pass entry to it
      if (m.status < STATUS.LOADED && !entry.history.hasOwnProperty(m.uri)) {
        // 当前模块的入口通过依赖的uri进行标定
        entry.history[m.uri] = true
        count++
        m._entry.push(entry)
        if(m.status === STATUS.LOADING) {
          m.pass()
        }
      }
    }
    // If has passed the entry to it's dependencies, modify the entry's count and del it in the module
    // 如果将入口模块都传递给了依赖
    // 不断将entry传递给依赖，传递完成后，该模块不再持有该入口

    if (count > 0) {
      entry.remain += count - 1
      mod._entry.shift()
      // 因为mod._entry.length在变化
      i--
    }
  }
}

/**
 * 加载当前模块的所有依赖模块,加载完成后, 调用onload回调
 * 在onload中，依赖的factory会被执行， 对外暴露该依赖
 * 该方法针对的是模块依赖
 * load某个模块依赖的初期，我们仅保存有依赖id
 */
Module.prototype.load = function() {
  var mod = this

  // 如果模块的依赖已经在加载了, 则跳出
  if (mod.status >= STATUS.LOADING) {
    return
  }

  // 标识当前模块的状态: 装载中
  mod.status = STATUS.LOADING

  // 首先,解析出模块的依赖项的真实地址, 即依赖项的uri
  var uris = mod.resolve()
  emit("load", uris)

  // 初始化当前模块的依赖模块
  for (var i = 0, len = uris.length; i < len; i++) {
    mod.deps[mod.dependencies[i]] = Module.get(uris[i])
  }

  // Pass entry to it's dependencies
  // 将自己的入口传给依赖， 例如main的入口为匿名模块anonymous，
  // 则依赖的入口显然应当具有入口anonymous
  mod.pass()

  // 如果当前模块还有尚未pass的entry, 执行load完成后的回调
  // If module has entries not be passed, call onload
  if (mod._entry.length) {
    mod.onload()
    return
  }

  // 开始并行加载模块

  var requestCache = {} // 设置一个请求缓存
  var m

  // 遍历各个依赖
  for (i = 0; i < len; i++) {
    m = cachedMods[uris[i]]

    // 如果模块文件尚未取得，则先取得依赖文件
    if (m.status < STATUS.FETCHING) {
      m.fetch(requestCache)
      // fetch结束后， m的模块内容尚未被请求到， 仅在requestCache中保存了请求函数
      // 之后再一起发送请求，即对于模块mod的各个依赖的请求将被并行发送
    }

    // 否则，如果依赖文件已经取得，则加载依赖的依赖
    else if (m.status === STATUS.SAVED) {
      m.load()
      // load结束后，m的依赖也被存储
    }

    // 否则什么都不需要做
  }

  // Send all requests at last to avoid cache bug in IE6-9. Issues#808
  // 由于将发送请求的方法暂存在了 requestCache中，所以我们可以延迟到此时一起发送
  for (var requestUri in requestCache) {
    if (requestCache.hasOwnProperty(requestUri)) {
      requestCache[requestUri]()
    }
  }
}

/**
 * 模块依赖加载完成后的回调
 * 模块依赖加载完成后意味着模块等待被执行
 */
Module.prototype.onload = function() {
  var mod = this
  mod.status = STATUS.LOADED

  // When sometimes cached in IE, exec will occur before onload, make sure len is an number
  // 遍历当前模块的各个子模块
  for (var i = 0, len = (mod._entry || []).length; i < len; i++) {
    var entry = mod._entry[i]
    // 向上回溯
    if (--entry.remain === 0) {
      entry.callback()
    }
  }

  delete mod._entry
}

/**
 * 当发生404时，调用该方法
 */
Module.prototype.error = function() {
  var mod = this
  mod.onload()
  mod.status = STATUS.ERROR
}

/**
 * 执行一个模块: 意味着执行该模块的factory方法，并返回待暴露对象exports
 * @returns {{}|*}
 */
Module.prototype.exec = function () {
  var mod = this

  // When module is executed, DO NOT execute it again. When module
  // is being executed, just return `module.exports` too, for avoiding
  // circularly calling
  // 如果模块已经执行了，不允许模块再次执行，暴露模块即可
  if (mod.status >= STATUS.EXECUTING) {
    return mod.exports
  }

  // 标识当前模块正在执行中
  mod.status = STATUS.EXECUTING

  if (mod._entry && !mod._entry.length) {
    delete mod._entry
  }

  //non-cmd module has no property factory and exports
  if (!mod.hasOwnProperty('factory')) {
    mod.non = true
    return
  }

  // 开始执行过程....

  // Create require
  var uri = mod.uri

  // 定义factory中的require函数

  /**
   * 定义factory中的require函数
   * @param id
   * @returns {{}|*}
     */
  function require(id) {
    // 是否require已存在与依赖中,如果是,直接从依赖中取得,否则, 新建一个模块
    var m = mod.deps[id] || Module.get(require.resolve(id))
    if (m.status == STATUS.ERROR) {
      throw new Error('module was broken: ' + m.uri)
    }
    // 模块require后，需要执行该模块
    return m.exec()
  }

  require.resolve = function(id) {
    return Module.resolve(id, uri)
  }

  /**
   * 支持异步获得模块
   * @param ids 模块依赖
   * @param callback, 模块加载完成后的回调
    */
  require.async = function(ids, callback) {
    Module.use(ids, callback, uri + "_async_" + cid())
    return require
  }

  // 执行工厂函数, 构造模块公开API
  var factory = mod.factory

  var exports = isFunction(factory) ?
    factory.call(mod.exports = {}, require, mod.exports, mod) :
    factory

  if (exports === undefined) {
    exports = mod.exports
  }

  // 执行完成后， factory函数不再需要， 删之可节省内存
  delete mod.factory

  // 设置该模块暴露的对象
  mod.exports = exports

  // 执行完毕
  mod.status = STATUS.EXECUTED

  // Emit `exec` event
  emit("exec", mod)

  return mod.exports
}

/**
 * 获得模块，意即获得模块的对应js文件，并保存到文档
 * @param requestCache
 */
Module.prototype.fetch = function(requestCache) {
  var mod = this
  var uri = mod.uri

  // 标识模块正在获取中
  mod.status = STATUS.FETCHING

  // Emit `fetch` event for plugins such as combo plugin
  var emitData = { uri: uri }
  emit("fetch", emitData)

  // 获得模块的请求地址
  var requestUri = emitData.requestUri || uri

  // 如果uri为空, 或者已经请求过该模块，则不再需要请求，开始加载依赖
  if (!requestUri || fetchedList.hasOwnProperty(requestUri)) {
    mod.load()
    return
  }


  // 如果模块已经在请求中，在回调队列中保存该模块对象（非模块内容）, 退出
  if (fetchingList.hasOwnProperty(requestUri)) {
    // 注意，同一个请求uri下的回调模块可能有多个
    callbackList[requestUri].push(mod)
    return
  }

  // 以请求地址标识当前模块正在请求中
  fetchingList[requestUri] = true
  //
  callbackList[requestUri] = [mod]

  // Emit `request` event for plugins such as text plugin
  emit("request", emitData = {
    uri: uri,
    requestUri: requestUri,
    onRequest: onRequest,
    charset: isFunction(data.charset) ? data.charset(requestUri) : data.charset,
    crossorigin: isFunction(data.crossorigin) ? data.crossorigin(requestUri) : data.crossorigin
  })

  // 如果设置了请求缓存，那么暂不执行请求，仅在requestCache中标记请求，为之后的并发请求提供可能
  // 如果未设置请求缓存，则立即发送请求
  if (!emitData.requested) {
    requestCache ?
      requestCache[emitData.requestUri] = sendRequest :
      sendRequest()
  }

  function sendRequest() {
    seajs.request(emitData.requestUri, emitData.onRequest, emitData.charset, emitData.crossorigin)
  }

  /**
   * 请求完成后的回调
   * 当模块请求成功后，亦即加载成功后，新的模块的脚本内容会通过<script>标签注入到文档中，
   * 由于<script>标签会自动运行，所以模块的define会被调用，如果define是合法的，模块会被初始化一些元信息
   * （依赖，factory等），同时，如果请求的模块是个具名模块(define('name',deps,factory))
   * define将会调用Module.save()存储模块，
   * 如果是匿名模块，onRequest()中会将其装换成具名模块存储，
   * 所以，请求成功后，模块的状态也会切换到SAVED
   *
   * @param error
     */
  function onRequest(error) {
    // 请求完成后， 从请求队列移出请求
    delete fetchingList[requestUri]
    // 标识该uri已经被请求
    fetchedList[requestUri] = true

    // 如果请求的是一个匿名模块文件
    // 需要转换匿名模块为具名模块
    if (anonymousMeta) {
      Module.save(uri, anonymousMeta)
      // 具名后， 匿名元信息不再需要
      anonymousMeta = null
    }

    // 一旦模块加载完成， 从callbackList中取出对应的模块队列
    // 以该模块为树根，加载模块子树
    var m, mods = callbackList[requestUri]
    delete callbackList[requestUri]
    while ((m = mods.shift())) {
      // When 404 occurs, the params error will be true
      if(error === true) {
        m.error()
      }
      else {
        // 加载模块依赖（模块子树），
        m.load()
      }
    }
  }
}

/**
 * 通过指定的模块id获得模块的uri
 * @param id
 * @param refUri
 * @returns {*}
 */
Module.resolve = function(id, refUri) {
  // Emit `resolve` event for plugins such as text plugin
  var emitData = { id: id, refUri: refUri }
  emit("resolve", emitData)

  return emitData.uri || seajs.resolve(emitData.id, refUri)
}

/**
 * 定义模块
 * @param id 指定模块id
 * @param deps 声明模块依赖
 * @param factory 模块的工厂函数
 */
Module.define = function (id, deps, factory) {
  var argsLen = arguments.length

  // 根据参数判断定义形式
  // define(factory)
  if (argsLen === 1) {
    factory = id
    id = undefined
  }
  else if (argsLen === 2) {
    // 如果传参为两个, 纠正第二个参数为factory
    factory = deps

    // define(deps, factory)
    // 纠正第一个参数
    if (isArray(id)) {
      deps = id
      id = undefined
    }
    // define(id, factory)
    else {
      deps = undefined
    }
  }

  // Parse dependencies according to the module factory code
  // 如果依赖实在factory函数中声明, 则需要解析factory的源码的
  if (!isArray(deps) && isFunction(factory)) {
    deps = typeof parseDependencies === "undefined" ? [] : parseDependencies(factory.toString())
  }

  /*
    一个模块的基本元信息应当包括（允许额外添加）:
    - id: 模块id
    - uri: 模块位置
    - deps: 模块依赖
    - factory: 工厂函数(如何生产这个模块)
   */
  var meta = {
    id: id,
    uri: Module.resolve(id),
    deps: deps,
    factory: factory
  }

  // Try to derive uri in IE6-9 for anonymous modules
  if (!isWebWorker && !meta.uri && doc.attachEvent && typeof getCurrentScript !== "undefined") {
    var script = getCurrentScript()

    if (script) {
      meta.uri = script.src
    }

    // NOTE: If the id-deriving methods above is failed, then falls back
    // to use onload event to get the uri
  }

  // Emit `define` event, used in nocache plugin, seajs node version etc
  emit("define", meta)

  // 如果define合法，则将模块状态切换到SAVED
  meta.uri ? Module.save(meta.uri, meta) :
    // Save information for "saving" work in the script onload event
    anonymousMeta = meta
}

/**
 * 将模块存储至缓存-cachedMods(以uri进行标识), 仅保存模块的元信息
 * @param uri 模块uri
 * @param meta 模块的元信息
 */
Module.save = function(uri, meta) {
  var mod = Module.get(uri)

  // Do NOT override already saved modules
  if (mod.status < STATUS.SAVED) {
    mod.id = meta.id || uri
    mod.dependencies = meta.deps || []
    mod.factory = meta.factory
    mod.status = STATUS.SAVED

    emit("save", mod)
  }
}

/**
 * 根据模块uri拿到模块,
 * 如果缓存中存在该模块，则直接从缓存中获得，
 * 如果缓存中不存在该模块,则新建一个模块并存至缓存
 * @param uri
 * @param deps 新建模块时所需要的依赖
 * @returns {*|Module}
 */
Module.get = function(uri, deps) {
  return cachedMods[uri] || (cachedMods[uri] = new Module(uri, deps))
}

/**
 * use()方法相当于加载一个匿名模块,
 * Ex. seajs.use('main', function(main))
 * 即创建了一个匿名模块，其依赖于main模块
 * @param ids 该匿名模块的依赖
 * @param callback 加载完成后的回调
 * @param uri 通过制定uri, 使得模块成为一个具名模块
 */
Module.use = function (ids, callback, uri) {

  // 创建一个匿名模块，其依赖模块由ids决定
  var mod = Module.get(uri, isArray(ids) ? ids : [ids])

  // 设定入口模块为该匿名模块
  mod._entry.push(mod)

  // 从use创建的匿名模块开始，记录各个模块的到达路径
  mod.history = {}

  // 初始化模块的剩余子模块
  mod.remain = 1

  // 初始化模块的回调
  mod.callback = function() {
    var exports = []
    var uris = mod.resolve()

    // 逐个执行module的依赖，以获得依赖暴露的对象
    for (var i = 0, len = uris.length; i < len; i++) {
      exports[i] = cachedMods[uris[i]].exec()
    }

    if (callback) {
      // 为callback传入依赖
      callback.apply(global, exports)
    }

    delete mod.callback
    delete mod.history
    delete mod.remain
    delete mod._entry
  }

  // 加载匿名模块的各个依赖：[main]
  mod.load()
}


// Public API

seajs.use = function(ids, callback) {
  Module.use(ids, callback, data.cwd + "_use_" + cid())
  return seajs
}

Module.define.cmd = {}

// 所以， 我们可以直接用define
global.define = Module.define

// For Developers

seajs.Module = Module
data.fetchedList = fetchedList
data.cid = cid

seajs.require = function(id) {
  var mod = Module.get(Module.resolve(id))
  if (mod.status < STATUS.EXECUTING) {
    mod.onload()
    mod.exec()
  }
  return mod.exports
}
