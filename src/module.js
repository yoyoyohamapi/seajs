/**
 * module.js - The core of module loader
 */

// 以下涉及到的事件分派主要交给seajs的插件完成,

// 用一个缓存对象来缓存模块, 各个模块以其uri进行标识
var cachedMods = seajs.cache = {}
var anonymousMeta

// 获取队列
var fetchingList = {}

// 以获取队列
var fetchedList = {}

// 回调队列
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
 * 从当前对象中解析出其依赖的uri数组
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
      // 如果该依赖尚未加载完毕, 并且没有在entry中使用,
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
    if (count > 0) {
      entry.remain += count - 1
      mod._entry.shift()
      i--
    }
  }
}

/**
 * 加载当前模块的所有依赖模块,加载完成后, 调用onload回调
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
  mod.pass()

  // 如果当前模块还有尚未通过的entry, 执行加载完成后的回调
  // If module has entries not be passed, call onload
  if (mod._entry.length) {
    mod.onload()
    return
  }

  // Begin parallel loading
  var requestCache = {}
  var m

  for (i = 0; i < len; i++) {
    m = cachedMods[uris[i]]

    if (m.status < STATUS.FETCHING) {
      m.fetch(requestCache)
    }
    else if (m.status === STATUS.SAVED) {
      m.load()
    }
  }

  // Send all requests at last to avoid cache bug in IE6-9. Issues#808
  for (var requestUri in requestCache) {
    if (requestCache.hasOwnProperty(requestUri)) {
      requestCache[requestUri]()
    }
  }
}

/**
 * 模块加载完成后的回调
 */
Module.prototype.onload = function() {
  var mod = this
  mod.status = STATUS.LOADED

  // When sometimes cached in IE, exec will occur before onload, make sure len is an number
  // 遍历当前模块的各个子模块
  for (var i = 0, len = (mod._entry || []).length; i < len; i++) {
    var entry = mod._entry[i]
    // 如果子模块加载完成, 执行子模块的回调
    if (--entry.remain === 0) {
      entry.callback()
    }
  }

  delete mod._entry
}

// Call this method when module is 404
Module.prototype.error = function() {
  var mod = this
  mod.onload()
  mod.status = STATUS.ERROR
}

/**
 * 执行一个模块
 * @returns {{}|*}
 */
Module.prototype.exec = function () {
  var mod = this

  // When module is executed, DO NOT execute it again. When module
  // is being executed, just return `module.exports` too, for avoiding
  // circularly calling
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
    // 执行该模块
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

  // Reduce memory leak
  delete mod.factory

  mod.exports = exports

  // 执行完毕
  mod.status = STATUS.EXECUTED

  // Emit `exec` event
  emit("exec", mod)

  return mod.exports
}

/**
 * 获得模块
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

  // 如果uri为空, 或者已经请求过该模块
  if (!requestUri || fetchedList.hasOwnProperty(requestUri)) {
    // 进入模块的加载过程, 加载该模块所需的依赖项
    mod.load()
    return
  }


  if (fetchingList.hasOwnProperty(requestUri)) {
    callbackList[requestUri].push(mod)
    return
  }

  fetchingList[requestUri] = true
  callbackList[requestUri] = [mod]

  // Emit `request` event for plugins such as text plugin
  emit("request", emitData = {
    uri: uri,
    requestUri: requestUri,
    onRequest: onRequest,
    charset: isFunction(data.charset) ? data.charset(requestUri) : data.charset,
    crossorigin: isFunction(data.crossorigin) ? data.crossorigin(requestUri) : data.crossorigin
  })

  if (!emitData.requested) {
    requestCache ?
      requestCache[emitData.requestUri] = sendRequest :
      sendRequest()
  }

  function sendRequest() {
    seajs.request(emitData.requestUri, emitData.onRequest, emitData.charset, emitData.crossorigin)
  }

  function onRequest(error) {
    delete fetchingList[requestUri]
    fetchedList[requestUri] = true

    // 为匿名模块设置元信息
    if (anonymousMeta) {
      Module.save(uri, anonymousMeta)
      anonymousMeta = null
    }

    // Call callbacks
    var m, mods = callbackList[requestUri]
    delete callbackList[requestUri]
    while ((m = mods.shift())) {
      // When 404 occurs, the params error will be true
      if(error === true) {
        m.error()
      }
      else {
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
    一个模块的基本元信息应当包括:
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
 * 根据模块uri拿到模块,如果缓存中已存在该模块,则新建一个模块
 * @param uri
 * @param deps 新建模块时所需要的依赖
 * @returns {*|Module}
 */
Module.get = function(uri, deps) {
  return cachedMods[uri] || (cachedMods[uri] = new Module(uri, deps))
}

/**
 * use()方法相当于加载一个匿名模块,
 * @param ids 该匿名模块的依赖
 * @param callback 加载完成后的回调
 * @param uri 通过制定uri, 使得模块成为一个具名模块
 */
Module.use = function (ids, callback, uri) {
  var mod = Module.get(uri, isArray(ids) ? ids : [ids])

  // 初始化模块的子模块
  mod._entry.push(mod)

  // 初始化模块的history
  mod.history = {}

  // 初始化模块的剩余子模块
  mod.remain = 1

  // 初始化模块的回调
  mod.callback = function() {
    var exports = []
    var uris = mod.resolve()

    for (var i = 0, len = uris.length; i < len; i++) {
      exports[i] = cachedMods[uris[i]].exec()
    }

    if (callback) {
      callback.apply(global, exports)
    }

    delete mod.callback
    delete mod.history
    delete mod.remain
    delete mod._entry
  }

  mod.load()
}


// Public API

seajs.use = function(ids, callback) {
  Module.use(ids, callback, data.cwd + "_use_" + cid())
  return seajs
}

Module.define.cmd = {}
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
