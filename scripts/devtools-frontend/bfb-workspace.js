/**
 * DevTools 工作区运行时（构建期注入，**勿手改 dist 副本**）。
 *
 * 内置 DevTools 前端跑在 hosted mode，`core/host/host.js` 会用
 * `InspectorFrontendHostStub`：它的 `addFileSystem` 只是往工作区塞一个
 * `filesystem:devtools://…/overrides` 的沙盒假条目，第二次点击还会撞
 * "A project with id … already exists"。本脚本把宿主侧那五个方法接管成
 * 「preload → IPC → 主进程真实文件系统」（见 src/main/modules/devtoolbox-workspace.ts），
 * 并用一个虚拟 DOM FileSystem 兼容层满足前端对 `FileSystem` / `FileEntry` /
 * `DirectoryEntry` / `FileWriter` 的调用。
 *
 * 为什么用「虚拟 DOM FileSystem」而不是直接改 persistence.js：上游代码只依赖
 * 这几个 Web 标准接口（`root.getFile` / `getDirectory` / `createReader` / `createWriter`），
 * 在宿主这一层补齐即可，punch 面最小、上游升级时不需要重写业务逻辑。
 */
(function () {
  'use strict';

  var bridge = window.bfbBridge;
  if (!bridge || !bridge.workspace) return;
  var ws = bridge.workspace;

  /** fileSystemName → 根目录描述（来自主进程清单）。 */
  var descriptors = new Map();
  /** fileSystemName → 虚拟 FileSystem 实例（isolatedFileSystem 必须同步返回）。 */
  var virtualFileSystems = new Map();

  var HOST_EVENTS = {
    fileSystemsLoaded: 'fileSystemsLoaded',
    fileSystemAdded: 'fileSystemAdded',
    fileSystemRemoved: 'fileSystemRemoved',
    fileSystemsChanged: 'FileSystemFilesChangedAddedRemoved',
    indexingTotalWorkCalculated: 'indexingTotalWorkCalculated',
    indexingWorked: 'indexingWorked',
    indexingDone: 'indexingDone',
    searchCompleted: 'searchCompleted',
  };

  // ---------- 路径与错误 ----------

  function domError(name, message) {
    try {
      return new DOMException(message || name, name);
    } catch (error) {
      var fallback = new Error(message || name);
      fallback.name = name;
      return fallback;
    }
  }

  function normalizeFullPath(value) {
    var text = String(value == null ? '' : value).replace(/\\/g, '/');
    if (text.charAt(0) !== '/') text = '/' + text;
    var parts = text.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }

  /** 虚拟文件系统里的 fullPath（'/a/b'）→ 主进程 IPC 用的相对路径（'a/b'）。 */
  function relativeOf(fullPath) {
    var normalized = normalizeFullPath(fullPath);
    return normalized === '/' ? '' : normalized.slice(1);
  }

  function joinFullPath(base, name) {
    return normalizeFullPath(String(base || '/') + '/' + String(name == null ? '' : name));
  }

  function baseName(fullPath) {
    var normalized = normalizeFullPath(fullPath);
    if (normalized === '/') return '';
    var index = normalized.lastIndexOf('/');
    return normalized.slice(index + 1);
  }

  function parentFullPath(fullPath) {
    var normalized = normalizeFullPath(fullPath);
    if (normalized === '/') return '/';
    var index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
  }

  function fromFailure(result, fallbackName) {
    var name = (result && result.error && result.error.name) || fallbackName || 'InvalidStateError';
    var message = (result && result.error && result.error.message) || name;
    return domError(name, message);
  }

  // ---------- Blob / base64 ----------

  function base64ToBytes(base64) {
    var binary = atob(base64 || '');
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function base64ToBlob(base64) {
    return new Blob([base64ToBytes(base64)]);
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(reader.error || domError('NotReadableError', '读取失败')); };
      reader.readAsDataURL(blob);
    });
  }

  // ---------- 虚拟 DOM FileSystem ----------

  function VirtualFileSystem(descriptor) {
    this.name = descriptor.fileSystemName;
    this.root = new VirtualDirectoryEntry(this, '/');
  }

  VirtualFileSystem.prototype._stat = function (fullPath) {
    return ws.stat(this.name, relativeOf(fullPath));
  };

  function VirtualFileEntry(fileSystem, fullPath) {
    this.isFile = true;
    this.isDirectory = false;
    this.filesystem = fileSystem;
    this.fullPath = normalizeFullPath(fullPath);
    this.name = baseName(this.fullPath);
  }

  VirtualFileEntry.prototype.file = function (success, error) {
    var fileSystem = this.filesystem;
    var relative = relativeOf(this.fullPath);
    ws.readFile(fileSystem.name, relative).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result, 'NotFoundError');
      success(base64ToBlob(result.base64));
    }).catch(function (failure) { error(failure); });
  };

  VirtualFileEntry.prototype.getMetadata = function (success, error) {
    var fileSystem = this.filesystem;
    ws.stat(fileSystem.name, relativeOf(this.fullPath)).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result, 'NotFoundError');
      if (!result.exists) throw domError('NotFoundError', '文件不存在');
      success({ modificationTime: new Date(result.mtimeMs), size: result.size });
    }).catch(function (failure) { error(failure); });
  };

  VirtualFileEntry.prototype.createWriter = function (success) {
    var fileSystem = this.filesystem;
    var relative = relativeOf(this.fullPath);
    var lastBytes = null;

    var writer = {
      onerror: null,
      onwriteend: null,
      onprogress: null,
      position: 0,
      length: 0,
      abort: function () { /* 单次写入没有可中止的排队 */ },
      truncate: function (size) {
        var target = Math.max(0, Number(size) || 0);
        var pending = Promise.resolve();
        if (lastBytes && target < lastBytes.length) {
          var sliced = lastBytes.slice(0, target);
          lastBytes = sliced;
          var binary = '';
          for (var i = 0; i < sliced.length; i += 1) binary += String.fromCharCode(sliced[i]);
          pending = ws.writeFile(fileSystem.name, relative, btoa(binary)).then(function (result) {
            if (!result || !result.ok) throw fromFailure(result);
          });
        }
        pending.then(function () {
          writer.length = lastBytes ? lastBytes.length : target;
          writer.position = writer.length;
          setTimeout(function () {
            try { if (writer.onwriteend) writer.onwriteend(); } catch (failure) { console.error(failure); }
          }, 0);
        }).catch(function (failure) { writer._fail(failure); });
      },
      write: function (blob) {
        blobToBase64(blob).then(function (base64) {
          lastBytes = base64ToBytes(base64);
          return ws.writeFile(fileSystem.name, relative, base64);
        }).then(function (result) {
          if (!result || !result.ok) throw fromFailure(result);
          writer.length = lastBytes ? lastBytes.length : 0;
          writer.position = writer.length;
          setTimeout(function () {
            try { if (writer.onwriteend) writer.onwriteend(); } catch (failure) { console.error(failure); }
          }, 0);
        }).catch(function (failure) { writer._fail(failure); });
      },
      _fail: function (failure) {
        setTimeout(function () {
          try { if (writer.onerror) writer.onerror(failure); } catch (ignored) { /* 前端自己的处理 */ }
        }, 0);
      },
    };
    success(writer);
  };

  VirtualFileEntry.prototype.remove = function (success, error) {
    var fileSystem = this.filesystem;
    ws.deletePath(fileSystem.name, relativeOf(this.fullPath), false).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      success();
    }).catch(function (failure) { error(failure); });
  };

  VirtualFileEntry.prototype.getParent = function (success) {
    success(new VirtualDirectoryEntry(this.filesystem, parentFullPath(this.fullPath)));
  };

  VirtualFileEntry.prototype.moveTo = function (parent, newName, success, error) {
    var fileSystem = this.filesystem;
    var targetFull = joinFullPath(parent && parent.fullPath ? parent.fullPath : '/', newName || this.name);
    ws.move(fileSystem.name, relativeOf(this.fullPath), relativeOf(targetFull)).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      success(new VirtualFileEntry(fileSystem, targetFull));
    }).catch(function (failure) { error(failure); });
  };

  VirtualFileEntry.prototype.copyTo = function (_parent, _newName, _success, error) {
    error(domError('NotSupportedError', '不支持复制'));
  };

  function VirtualDirectoryEntry(fileSystem, fullPath) {
    this.isFile = false;
    this.isDirectory = true;
    this.filesystem = fileSystem;
    this.fullPath = normalizeFullPath(fullPath);
    this.name = baseName(this.fullPath);
  }

  VirtualDirectoryEntry.prototype._ensureFileSystem = function () {
    // 目录条目构造时一定带 FileSystem（根条目自己建，子条目继承父条目的）。
    return this.filesystem;
  };

  VirtualDirectoryEntry.prototype.createReader = function () {
    var self = this;
    var consumed = false;
    return {
      readEntries: function (success, error) {
        // DOM 约定：读完后返回空数组；前端会一直读到空为止。
        if (consumed) { success([]); return; }
        consumed = true;
        var fileSystem = self._ensureFileSystem();
        ws.readDir(fileSystem.name, relativeOf(self.fullPath)).then(function (result) {
          if (!result || !result.ok) throw fromFailure(result);
          success(result.entries.map(function (entry) {
            var full = joinFullPath(self.fullPath, entry.name);
            return entry.isDirectory
              ? new VirtualDirectoryEntry(fileSystem, full)
              : new VirtualFileEntry(fileSystem, full);
          }));
        }).catch(function (failure) {
          // 目录不存在/无权限：返回空列表而不是抛错，调用方按"空目录"处理
          console.warn('[bfb-workspace] 读取目录失败:', self.fullPath, failure && failure.message);
          success([]);
        });
      },
    };
  };

  VirtualDirectoryEntry.prototype.getFile = function (path, options, success, error) {
    var fileSystem = this.filesystem;
    var full = joinFullPath(this.fullPath, path);
    var create = Boolean(options && options.create);
    var exclusive = Boolean(options && options.exclusive);
    fileSystem._stat(full).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      if (result.exists) {
        if (result.isDirectory) throw domError('TypeMismatchError', '这是一个文件夹');
        if (create && exclusive) throw domError('InvalidModificationError', '文件已存在');
        return new VirtualFileEntry(fileSystem, full);
      }
      if (!create) throw domError('NotFoundError', '文件不存在');
      return ws.createFile(fileSystem.name, relativeOf(full), exclusive).then(function (created) {
        if (!created || !created.ok) throw fromFailure(created);
        return new VirtualFileEntry(fileSystem, full);
      });
    }).then(function (entry) {
      success(entry);
    }).catch(function (failure) { error(failure); });
  };

  VirtualDirectoryEntry.prototype.getDirectory = function (path, options, success, error) {
    var fileSystem = this.filesystem;
    var full = joinFullPath(this.fullPath, path);
    var create = Boolean(options && options.create);
    fileSystem._stat(full).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      if (result.exists) {
        if (!result.isDirectory) throw domError('TypeMismatchError', '这是一个文件');
        return new VirtualDirectoryEntry(fileSystem, full);
      }
      if (!create) throw domError('NotFoundError', '文件夹不存在');
      return ws.createDirectory(fileSystem.name, relativeOf(full)).then(function (created) {
        if (!created || !created.ok) throw fromFailure(created);
        return new VirtualDirectoryEntry(fileSystem, full);
      });
    }).then(function (entry) {
      success(entry);
    }).catch(function (failure) { error(failure); });
  };

  VirtualDirectoryEntry.prototype.removeRecursively = function (success, error) {
    var fileSystem = this._ensureFileSystem();
    ws.deletePath(fileSystem.name, relativeOf(this.fullPath), true).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      success();
    }).catch(function (failure) { error(failure); });
  };

  VirtualDirectoryEntry.prototype.getMetadata = function (success, error) {
    var fileSystem = this.filesystem;
    ws.stat(fileSystem.name, relativeOf(this.fullPath)).then(function (result) {
      if (!result || !result.ok) throw fromFailure(result);
      success({ modificationTime: new Date(result.mtimeMs), size: 0 });
    }).catch(function (failure) { error(failure); });
  };

  VirtualDirectoryEntry.prototype.getParent = function (success) {
    success(new VirtualDirectoryEntry(this.filesystem, parentFullPath(this.fullPath)));
  };

  function getVirtualFileSystem(descriptor) {
    var existing = virtualFileSystems.get(descriptor.fileSystemName);
    if (existing) return existing;
    var created = new VirtualFileSystem(descriptor);
    virtualFileSystems.set(descriptor.fileSystemName, created);
    return created;
  }

  // ---------- 宿主方法 ----------

  function emit(type, data) {
    var host = globalThis.InspectorFrontendHost;
    if (!host || !host.events) return;
    try {
      host.events.dispatchEventToListeners(type, data);
    } catch (failure) {
      console.error('[bfb-workspace] 事件派发失败:', type, failure);
    }
  }

  function registerDescriptor(descriptor) {
    if (!descriptor || !descriptor.fileSystemName) return;
    descriptors.set(descriptor.fileSystemName, descriptor);
    getVirtualFileSystem(descriptor);
  }

  function requestFileSystems() {
    ws.list().then(function (result) {
      // preload 统一返回 `{ ok, roots }` 信封（失败时给 `{ ok:false, error }`）
      var list = result && result.ok && Array.isArray(result.roots) ? result.roots : [];
      for (var i = 0; i < list.length; i += 1) registerDescriptor(list[i]);
      emit(HOST_EVENTS.fileSystemsLoaded, list);
    }).catch(function (failure) {
      console.warn('[bfb-workspace] 读取工作区清单失败:', failure && failure.message);
      emit(HOST_EVENTS.fileSystemsLoaded, []);
    });
  }

  function addFileSystem(type) {
    ws.pick(typeof type === 'string' ? type : '').then(function (result) {
      if (!result || result.cancelled || result.duplicate) {
        // 与原生宿主一致：取消用这个固定字符串，前端据此静默收尾
        emit(HOST_EVENTS.fileSystemAdded, { errorMessage: '<selection cancelled>' });
        return;
      }
      if (result.error || !result.fileSystem) {
        emit(HOST_EVENTS.fileSystemAdded, { errorMessage: result.error || 'unknown error' });
        return;
      }
      registerDescriptor(result.fileSystem);
      emit(HOST_EVENTS.fileSystemAdded, { fileSystem: result.fileSystem });
    }).catch(function (failure) {
      emit(HOST_EVENTS.fileSystemAdded, { errorMessage: String((failure && failure.message) || failure) });
    });
  }

  function removeFileSystem(embedderPath) {
    ws.remove(String(embedderPath || '')).then(function (result) {
      if (!result || !result.ok) {
        console.error('[bfb-workspace] 移除工作区文件夹失败:', result && result.error && result.error.message);
        return;
      }
      descriptors.forEach(function (descriptor, name) {
        if (descriptor.fileSystemPath === embedderPath) {
          descriptors.delete(name);
          virtualFileSystems.delete(name);
        }
      });
      emit(HOST_EVENTS.fileSystemRemoved, embedderPath);
    }).catch(function (failure) {
      console.error('[bfb-workspace] 移除工作区文件夹失败:', failure && failure.message);
    });
  }

  function isolatedFileSystem(fileSystemName) {
    var descriptor = descriptors.get(fileSystemName);
    if (!descriptor) return null;
    return getVirtualFileSystem(descriptor);
  }

  /**
   * 索引：主进程在添加文件夹时就把路径索引建好了（之后靠 watcher 增量维护），
   * 这里只需要把进度事件补齐——不发 indexingDone 的话 Sources 的文件搜索永远停在 0%。
   */
  function indexPath(requestId) {
    setTimeout(function () {
      emit(HOST_EVENTS.indexingTotalWorkCalculated, { requestId: requestId, fileSystemPath: '', totalWork: 1 });
      emit(HOST_EVENTS.indexingWorked, { requestId: requestId, fileSystemPath: '', worked: 1 });
      emit(HOST_EVENTS.indexingDone, { requestId: requestId });
    }, 0);
  }

  function searchInPath(requestId, fileSystemPath, query) {
    ws.search(String(fileSystemPath || ''), String(query || '')).then(function (result) {
      emit(HOST_EVENTS.searchCompleted, {
        requestId: requestId,
        files: result && result.ok ? result.files : [],
      });
    }).catch(function () {
      emit(HOST_EVENTS.searchCompleted, { requestId: requestId, files: [] });
    });
  }

  /**
   * 外部编辑器的改动：主进程的 watcher 推来「根目录路径 + 增/改/删的相对路径」，
   * 这里翻译成前端 `IsolatedFileSystemManager` 认的
   * `FileSystemFilesChangedAddedRemoved`（参数是**绝对文件路径**数组）。
   *
   * 少了这一步，用户在 VS Code 里改了工作区文件，Sources 面板不会自己刷新。
   */
  function onWorkspaceChanges(payload) {
    if (!payload || typeof payload !== 'object') return;
    var rootPath = payload.fileSystemPath;
    var change = payload.change || {};
    if (typeof rootPath !== 'string' || !rootPath) return;

    var prefix = String(rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
    function toAbsolute(list) {
      if (!Array.isArray(list)) return [];
      return list.map(function (relative) {
        var clean = String(relative == null ? '' : relative).replace(/\\/g, '/').replace(/^\/+/, '');
        return prefix + '/' + clean;
      });
    }

    var changed = toAbsolute(change.changed);
    var added = toAbsolute(change.added);
    var removed = toAbsolute(change.removed);
    if (!changed.length && !added.length && !removed.length) return;
    emit(HOST_EVENTS.fileSystemsChanged, { changed: changed, added: added, removed: removed });
  }

  function patchHost(host) {
    if (!host || host.__bfbWorkspacePatched) return host;
    Object.defineProperty(host, '__bfbWorkspacePatched', { value: true, enumerable: false });
    host.requestFileSystems = requestFileSystems;
    host.addFileSystem = addFileSystem;
    host.removeFileSystem = removeFileSystem;
    host.isolatedFileSystem = isolatedFileSystem;
    host.indexPath = indexPath;
    host.stopIndexing = function () { /* 索引常驻主进程，没有可中止的前台任务 */ };
    host.searchInPath = searchInPath;
    return host;
  }

  // 主进程 watcher 推来的变更（外部编辑器改动）。preload 在脚本执行前就已经挂了
  // ipcRenderer 监听，所以这里注册后不会漏事件。
  if (typeof ws.onChanges === 'function') ws.onChanges(onWorkspaceChanges);

  // host.js 在模块初始化时才创建 InspectorFrontendHost（`globalThis.InspectorFrontendHost = new Stub`）。
  // 模块脚本是 deferred 的，本脚本先跑，所以用访问器在赋值那一刻接管：
  // 既不抢先定义（会触发 "Incompatible embedder: method ... is missing" 的一串 console.error），
  // 也不晚于 IsolatedFileSystemManager 构造时的那次 requestFileSystems()。
  (function installHostHook() {
    var current = globalThis.InspectorFrontendHost;
    if (current) {
      patchHost(current);
      return;
    }
    Object.defineProperty(globalThis, 'InspectorFrontendHost', {
      configurable: true,
      get: function () { return current; },
      set: function (value) {
        current = value;
        patchHost(value);
      },
    });
  })();
})();
