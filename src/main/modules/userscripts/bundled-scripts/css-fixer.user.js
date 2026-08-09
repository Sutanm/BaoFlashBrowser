// ==UserScript==
// @name         BaoFlash Modern CSS Fixer
// @namespace    bao-flash-browser
// @version      0.5.7
// @updateHash  dbec8f180460
// @description  Restores modern-CSS rules that Chromium 87 drops (:where/:is unwrap, @layer flatten, dvh, colors). Covers ruffle.rs + github.com; add more sites in the editor.
// @match        *://*.ruffle.rs/*
// @match        *://*.github.com/*
// @run-at       document-start
// ==/UserScript==

"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e4) {
      throw mod = 0, e4;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/picocolors/picocolors.browser.js
  var require_picocolors_browser = __commonJS({
    "node_modules/picocolors/picocolors.browser.js"(exports, module) {
      var x2 = String;
      var create = function() {
        return { isColorSupported: false, reset: x2, bold: x2, dim: x2, italic: x2, underline: x2, inverse: x2, hidden: x2, strikethrough: x2, black: x2, red: x2, green: x2, yellow: x2, blue: x2, magenta: x2, cyan: x2, white: x2, gray: x2, bgBlack: x2, bgRed: x2, bgGreen: x2, bgYellow: x2, bgBlue: x2, bgMagenta: x2, bgCyan: x2, bgWhite: x2, blackBright: x2, redBright: x2, greenBright: x2, yellowBright: x2, blueBright: x2, magentaBright: x2, cyanBright: x2, whiteBright: x2, bgBlackBright: x2, bgRedBright: x2, bgGreenBright: x2, bgYellowBright: x2, bgBlueBright: x2, bgMagentaBright: x2, bgCyanBright: x2, bgWhiteBright: x2 };
      };
      module.exports = create();
      module.exports.createColors = create;
    }
  });

  // (disabled):node_modules/postcss/lib/terminal-highlight
  var require_terminal_highlight = __commonJS({
    "(disabled):node_modules/postcss/lib/terminal-highlight"() {
    }
  });

  // node_modules/postcss/lib/css-syntax-error.js
  var require_css_syntax_error = __commonJS({
    "node_modules/postcss/lib/css-syntax-error.js"(exports, module) {
      "use strict";
      var pico = require_picocolors_browser();
      var terminalHighlight = require_terminal_highlight();
      var CssSyntaxError2 = class _CssSyntaxError extends Error {
        constructor(message, line, column, source, file, plugin2) {
          super(message);
          this.name = "CssSyntaxError";
          this.reason = message;
          if (file) {
            this.file = file;
          }
          if (source) {
            this.source = source;
          }
          if (plugin2) {
            this.plugin = plugin2;
          }
          if (typeof line !== "undefined" && typeof column !== "undefined") {
            if (typeof line === "number") {
              this.line = line;
              this.column = column;
            } else {
              this.line = line.line;
              this.column = line.column;
              this.endLine = column.line;
              this.endColumn = column.column;
            }
          }
          this.setMessage();
          if (Error.captureStackTrace) {
            Error.captureStackTrace(this, _CssSyntaxError);
          }
        }
        setMessage() {
          this.message = this.plugin ? this.plugin + ": " : "";
          this.message += this.file ? this.file : "<css input>";
          if (typeof this.line !== "undefined") {
            this.message += ":" + this.line + ":" + this.column;
          }
          this.message += ": " + this.reason;
        }
        showSourceCode(color) {
          if (!this.source) return "";
          let css = this.source;
          if (color == null) color = pico.isColorSupported;
          let aside = (text) => text;
          let mark = (text) => text;
          let highlight = (text) => text;
          if (color) {
            let { bold, gray, red } = pico.createColors(true);
            mark = (text) => bold(red(text));
            aside = (text) => gray(text);
            if (terminalHighlight) {
              highlight = (text) => terminalHighlight(text);
            }
          }
          let lines = css.split(/\r?\n/);
          let start = Math.max(this.line - 3, 0);
          let end = Math.min(this.line + 2, lines.length);
          let maxWidth = String(end).length;
          return lines.slice(start, end).map((line, index) => {
            let number = start + 1 + index;
            let gutter = " " + (" " + number).slice(-maxWidth) + " | ";
            if (number === this.line) {
              if (line.length > 160) {
                let padding = 20;
                let subLineStart = Math.max(0, this.column - padding);
                let subLineEnd = Math.max(
                  this.column + padding,
                  this.endColumn + padding
                );
                let subLine = line.slice(subLineStart, subLineEnd);
                let spacing2 = aside(gutter.replace(/\d/g, " ")) + line.slice(0, Math.min(this.column - 1, padding - 1)).replace(/[^\t]/g, " ");
                return mark(">") + aside(gutter) + highlight(subLine) + "\n " + spacing2 + mark("^");
              }
              let spacing = aside(gutter.replace(/\d/g, " ")) + line.slice(0, this.column - 1).replace(/[^\t]/g, " ");
              return mark(">") + aside(gutter) + highlight(line) + "\n " + spacing + mark("^");
            }
            return " " + aside(gutter) + highlight(line);
          }).join("\n");
        }
        toString() {
          let code = this.showSourceCode();
          if (code) {
            code = "\n\n" + code + "\n";
          }
          return this.name + ": " + this.message + code;
        }
      };
      module.exports = CssSyntaxError2;
      CssSyntaxError2.default = CssSyntaxError2;
    }
  });

  // node_modules/postcss/lib/stringifier.js
  var require_stringifier = __commonJS({
    "node_modules/postcss/lib/stringifier.js"(exports, module) {
      "use strict";
      var STYLE_TAG = /(<)(\/?style\b)/gi;
      var COMMENT_OPEN = /(<)(!--)/g;
      var AT_NAME_END = /[\t\n\f\r "#'()/;[\\\]{}]/;
      function escapeHTMLInCSS(str) {
        if (typeof str !== "string") return str;
        if (!str.includes("<")) return str;
        return str.replace(STYLE_TAG, "\\3c $2").replace(COMMENT_OPEN, "\\3c $2");
      }
      var DEFAULT_RAW = {
        after: "\n",
        beforeClose: "\n",
        beforeComment: "\n",
        beforeDecl: "\n",
        beforeOpen: " ",
        beforeRule: "\n",
        colon: ": ",
        commentLeft: " ",
        commentRight: " ",
        emptyBody: "",
        indent: "    ",
        semicolon: false
      };
      function capitalize(str) {
        return str[0].toUpperCase() + str.slice(1);
      }
      function atruleStart(str, node) {
        let name = "@" + node.name;
        let params = node.params ? str.rawValue(node, "params") : "";
        let afterName = node.raws.afterName;
        if (typeof afterName === "undefined") {
          afterName = params ? " " : "";
        } else if (afterName === "" && params && !AT_NAME_END.test(params[0])) {
          afterName = " ";
        }
        return name + afterName + params;
      }
      function pushBody(str, stack, node) {
        let nodes = node.nodes;
        let last = nodes.length - 1;
        while (last > 0) {
          if (nodes[last].type !== "comment") break;
          last -= 1;
        }
        let semicolon = str.raw(node, "semicolon");
        let isDocument = node.type === "document";
        for (let i2 = nodes.length - 1; i2 >= 0; i2--) {
          let child = nodes[i2];
          let childSemicolon = last !== i2 || semicolon;
          if (!childSemicolon && i2 < nodes.length - 1 && (child.type === "atrule" && !child.nodes || child.type === "decl" && child.prop.startsWith("--"))) {
            childSemicolon = true;
          }
          stack.push({
            document: isDocument,
            node: child,
            semicolon: childSemicolon
          });
        }
      }
      function pushBlock(str, stack, node, start) {
        let between = str.raw(node, "between", "beforeOpen");
        str.builder(escapeHTMLInCSS(start + between) + "{", node, "start");
        let hasNodes = node.nodes && node.nodes.length;
        let close = () => {
          let after = hasNodes ? str.raw(node, "after") : str.raw(node, "after", "emptyBody");
          if (after) str.builder(escapeHTMLInCSS(after));
          str.builder("}", node, "end");
          if (node.type === "rule" && node.raws.ownSemicolon) {
            str.builder(escapeHTMLInCSS(node.raws.ownSemicolon), node, "end");
          }
        };
        if (hasNodes) {
          stack.push(close);
          pushBody(str, stack, node);
        } else {
          close();
        }
      }
      var Stringifier = class _Stringifier {
        constructor(builder) {
          this.builder = builder;
        }
        atrule(node, semicolon) {
          let start = atruleStart(this, node);
          if (node.nodes) {
            this.block(node, start);
          } else {
            let end = (node.raws.between || "") + (semicolon ? ";" : "");
            this.builder(escapeHTMLInCSS(start + end), node);
          }
        }
        beforeAfter(node, detect) {
          let value;
          if (node.type === "decl") {
            value = this.raw(node, null, "beforeDecl");
          } else if (node.type === "comment") {
            value = this.raw(node, null, "beforeComment");
          } else if (detect === "before") {
            value = this.raw(node, null, "beforeRule");
          } else {
            value = this.raw(node, null, "beforeClose");
          }
          let buf = node.parent;
          let depth = 0;
          while (buf && buf.type !== "root") {
            depth += 1;
            buf = buf.parent;
          }
          if (value.includes("\n")) {
            let indent = this.raw(node, null, "indent");
            if (indent.length) {
              for (let step = 0; step < depth; step++) value += indent;
            }
          }
          return value;
        }
        block(node, start) {
          let between = this.raw(node, "between", "beforeOpen");
          this.builder(escapeHTMLInCSS(start + between) + "{", node, "start");
          let after;
          if (node.nodes && node.nodes.length) {
            this.body(node);
            after = this.raw(node, "after");
          } else {
            after = this.raw(node, "after", "emptyBody");
          }
          if (after) this.builder(escapeHTMLInCSS(after));
          this.builder("}", node, "end");
        }
        body(node) {
          let proto = _Stringifier.prototype;
          let expandable = ["atrule", "block", "body", "rule", "stringify"].every(
            (method) => this[method] === proto[method]
          );
          let stack = [];
          pushBody(this, stack, node);
          while (stack.length > 0) {
            let entry = stack.pop();
            if (typeof entry === "function") {
              entry();
              continue;
            }
            let child = entry.node;
            let before = this.raw(child, "before");
            if (before) {
              this.builder(entry.document ? before : escapeHTMLInCSS(before));
            }
            if (expandable && child.type === "rule") {
              pushBlock(this, stack, child, this.rawValue(child, "selector"));
            } else if (expandable && child.type === "atrule" && child.nodes) {
              pushBlock(this, stack, child, atruleStart(this, child));
            } else {
              this.stringify(child, entry.semicolon);
            }
          }
        }
        comment(node) {
          let left = this.raw(node, "left", "commentLeft");
          let right = this.raw(node, "right", "commentRight");
          this.builder(escapeHTMLInCSS("/*" + left + node.text + right + "*/"), node);
        }
        decl(node, semicolon) {
          let raws = node.raws;
          let between = this.raw(node, "between", "colon");
          let string = node.prop + between + this.rawValue(node, "value");
          if (node.important) {
            string += raws.important || " !important";
          }
          if (semicolon) string += ";";
          this.builder(escapeHTMLInCSS(string), node);
        }
        document(node) {
          this.body(node);
        }
        raw(node, own, detect) {
          let value;
          if (!detect) detect = own;
          if (own) {
            value = node.raws[own];
            if (typeof value !== "undefined") return value;
          }
          let parent = node.parent;
          if (detect === "before") {
            if (!parent || parent.type === "root" && parent.first === node) {
              return "";
            }
            if (parent && parent.type === "document") {
              return "";
            }
          }
          if (!parent) return DEFAULT_RAW[detect];
          let root2 = node.root();
          let cache = root2.rawCache || (root2.rawCache = {});
          if (typeof cache[detect] !== "undefined") {
            return cache[detect];
          }
          if (detect === "before" || detect === "after") {
            return this.beforeAfter(node, detect);
          } else {
            let method = "raw" + capitalize(detect);
            if (this[method]) {
              value = this[method](root2, node);
            } else {
              root2.walk((i2) => {
                value = i2.raws[own];
                if (typeof value !== "undefined") return false;
              });
            }
          }
          if (typeof value === "undefined") value = DEFAULT_RAW[detect];
          cache[detect] = value;
          return value;
        }
        rawBeforeClose(root2) {
          let value;
          root2.walk((i2) => {
            if (i2.nodes && i2.nodes.length > 0) {
              if (typeof i2.raws.after !== "undefined") {
                value = i2.raws.after;
                if (value.includes("\n")) {
                  value = value.replace(/[^\n]+$/, "");
                }
                return false;
              }
            }
          });
          if (value) value = value.replace(/\S/g, "");
          return value;
        }
        rawBeforeComment(root2, node) {
          let value;
          root2.walkComments((i2) => {
            if (typeof i2.raws.before !== "undefined") {
              value = i2.raws.before;
              if (value.includes("\n")) {
                value = value.replace(/[^\n]+$/, "");
              }
              return false;
            }
          });
          if (typeof value === "undefined") {
            value = this.raw(node, null, "beforeDecl");
          } else if (value) {
            value = value.replace(/\S/g, "");
          }
          return value;
        }
        rawBeforeDecl(root2, node) {
          let value;
          root2.walkDecls((i2) => {
            if (typeof i2.raws.before !== "undefined") {
              value = i2.raws.before;
              if (value.includes("\n")) {
                value = value.replace(/[^\n]+$/, "");
              }
              return false;
            }
          });
          if (typeof value === "undefined") {
            value = this.raw(node, null, "beforeRule");
          } else if (value) {
            value = value.replace(/\S/g, "");
          }
          return value;
        }
        rawBeforeOpen(root2) {
          let value;
          root2.walk((i2) => {
            if (i2.type !== "decl") {
              value = i2.raws.between;
              if (typeof value !== "undefined") return false;
            }
          });
          return value;
        }
        rawBeforeRule(root2) {
          let value;
          root2.walk((i2) => {
            if (i2.nodes && (i2.parent !== root2 || root2.first !== i2)) {
              if (typeof i2.raws.before !== "undefined") {
                value = i2.raws.before;
                if (value.includes("\n")) {
                  value = value.replace(/[^\n]+$/, "");
                }
                return false;
              }
            }
          });
          if (value) value = value.replace(/\S/g, "");
          return value;
        }
        rawColon(root2) {
          let value;
          root2.walkDecls((i2) => {
            if (typeof i2.raws.between !== "undefined") {
              value = i2.raws.between.replace(/[^\s:]/g, "");
              return false;
            }
          });
          return value;
        }
        rawEmptyBody(root2) {
          let value;
          root2.walk((i2) => {
            if (i2.nodes && i2.nodes.length === 0) {
              value = i2.raws.after;
              if (typeof value !== "undefined") return false;
            }
          });
          return value;
        }
        rawIndent(root2) {
          if (root2.raws.indent) return root2.raws.indent;
          let value;
          root2.walk((i2) => {
            let p2 = i2.parent;
            if (p2 && p2 !== root2 && p2.parent && p2.parent === root2) {
              if (typeof i2.raws.before !== "undefined") {
                let parts = i2.raws.before.split("\n");
                value = parts[parts.length - 1];
                value = value.replace(/\S/g, "");
                return false;
              }
            }
          });
          return value;
        }
        rawSemicolon(root2) {
          let value;
          root2.walk((i2) => {
            if (i2.nodes && i2.nodes.length && i2.last.type === "decl") {
              value = i2.raws.semicolon;
              if (typeof value !== "undefined") return false;
            }
          });
          return value;
        }
        rawValue(node, prop) {
          let value = node[prop];
          let raw = node.raws[prop];
          if (raw && raw.value === value) {
            return raw.raw;
          }
          return value;
        }
        root(node) {
          if (node.source && node.source.input.hasBOM) {
            this.builder("\uFEFF", node, "start");
          }
          this.body(node);
          if (node.raws.after) {
            let after = node.raws.after;
            let isDocument = node.parent && node.parent.type === "document";
            this.builder(isDocument ? after : escapeHTMLInCSS(after));
          }
        }
        rule(node) {
          this.block(node, this.rawValue(node, "selector"));
          if (node.raws.ownSemicolon) {
            this.builder(escapeHTMLInCSS(node.raws.ownSemicolon), node, "end");
          }
        }
        stringify(node, semicolon) {
          if (!this[node.type]) {
            throw new Error(
              "Unknown AST node type " + node.type + ". Maybe you need to change PostCSS stringifier."
            );
          }
          this[node.type](node, semicolon);
        }
      };
      module.exports = Stringifier;
      Stringifier.default = Stringifier;
    }
  });

  // node_modules/postcss/lib/stringify.js
  var require_stringify = __commonJS({
    "node_modules/postcss/lib/stringify.js"(exports, module) {
      "use strict";
      var Stringifier = require_stringifier();
      function stringify2(node, builder) {
        let str = new Stringifier(builder);
        str.stringify(node);
      }
      module.exports = stringify2;
      stringify2.default = stringify2;
    }
  });

  // node_modules/postcss/lib/symbols.js
  var require_symbols = __commonJS({
    "node_modules/postcss/lib/symbols.js"(exports, module) {
      "use strict";
      module.exports.isClean = /* @__PURE__ */ Symbol("isClean");
      module.exports.my = /* @__PURE__ */ Symbol("my");
    }
  });

  // node_modules/postcss/lib/node.js
  var require_node = __commonJS({
    "node_modules/postcss/lib/node.js"(exports, module) {
      "use strict";
      var CssSyntaxError2 = require_css_syntax_error();
      var Stringifier = require_stringifier();
      var stringify2 = require_stringify();
      var { isClean, my } = require_symbols();
      function cloneNode(obj, parent) {
        let cloned = new obj.constructor();
        let stack = [[obj, cloned, parent]];
        while (stack.length > 0) {
          let [source, target, targetParent] = stack.pop();
          for (let i2 in source) {
            if (!Object.prototype.hasOwnProperty.call(source, i2)) {
              continue;
            }
            if (i2 === "proxyCache") continue;
            let value = source[i2];
            let type = typeof value;
            if (i2 === "parent" && type === "object") {
              if (targetParent) target[i2] = targetParent;
            } else if (i2 === "source") {
              target[i2] = value;
            } else if (Array.isArray(value)) {
              let children = [];
              target[i2] = children;
              for (let j2 of value) {
                let childClone = new j2.constructor();
                children.push(childClone);
                stack.push([j2, childClone, target]);
              }
            } else {
              if (type === "object" && value !== null) {
                let valueClone = new value.constructor();
                stack.push([value, valueClone, void 0]);
                value = valueClone;
              }
              target[i2] = value;
            }
          }
        }
        return cloned;
      }
      function sourceOffset(inputCSS, position) {
        if (position && typeof position.offset !== "undefined") {
          return position.offset;
        }
        let column = 1;
        let line = 1;
        let offset = 0;
        for (let i2 = 0; i2 < inputCSS.length; i2++) {
          if (line === position.line && column === position.column) {
            offset = i2;
            break;
          }
          if (inputCSS[i2] === "\n") {
            column = 1;
            line += 1;
          } else {
            column += 1;
          }
        }
        return offset;
      }
      var Node3 = class _Node {
        get proxyOf() {
          return this;
        }
        constructor(defaults = {}) {
          this.raws = {};
          this[isClean] = false;
          this[my] = true;
          for (let name of Object.keys(defaults)) {
            if (name === "__proto__") continue;
            if (name === "nodes") {
              this.nodes = [];
              for (let node of defaults[name]) {
                if (typeof node.clone === "function" && node.parent) {
                  this.append(node.clone());
                } else {
                  this.append(node);
                }
              }
            } else {
              this[name] = defaults[name];
            }
          }
        }
        addToError(error) {
          error.postcssNode = this;
          if (error.stack && this.source && /\n\s{4}at /.test(error.stack)) {
            let s2 = this.source;
            error.stack = error.stack.replace(
              /\n\s{4}at /,
              `$&${s2.input.from}:${s2.start.line}:${s2.start.column}$&`
            );
          }
          return error;
        }
        after(add) {
          this.parent.insertAfter(this, add);
          return this;
        }
        assign(overrides = {}) {
          for (let name in overrides) {
            this[name] = overrides[name];
          }
          return this;
        }
        before(add) {
          this.parent.insertBefore(this, add);
          return this;
        }
        cleanRaws(keepBetween) {
          delete this.raws.before;
          delete this.raws.after;
          if (!keepBetween) delete this.raws.between;
        }
        clone(overrides = {}) {
          let cloned = cloneNode(this);
          for (let name in overrides) {
            cloned[name] = overrides[name];
          }
          return cloned;
        }
        cloneAfter(overrides = {}) {
          let cloned = this.clone(overrides);
          this.parent.insertAfter(this, cloned);
          return cloned;
        }
        cloneBefore(overrides = {}) {
          let cloned = this.clone(overrides);
          this.parent.insertBefore(this, cloned);
          return cloned;
        }
        error(message, opts = {}) {
          if (this.source) {
            let { end, start } = this.rangeBy(opts);
            return this.source.input.error(
              message,
              { column: start.column, line: start.line },
              { column: end.column, line: end.line },
              opts
            );
          }
          return new CssSyntaxError2(message);
        }
        getProxyProcessor() {
          return {
            get(node, prop) {
              if (prop === "proxyOf") {
                return node;
              } else if (prop === "root") {
                return () => node.root().toProxy();
              } else {
                return node[prop];
              }
            },
            set(node, prop, value) {
              if (node[prop] === value) return true;
              node[prop] = value;
              if (prop === "prop" || prop === "value" || prop === "name" || prop === "params" || prop === "important" || /* c8 ignore next */
              prop === "text") {
                node.markDirty();
              }
              return true;
            }
          };
        }
        /* c8 ignore next 3 */
        markClean() {
          this[isClean] = true;
        }
        markDirty() {
          if (this[isClean]) {
            this[isClean] = false;
            let next = this;
            while (next = next.parent) {
              next[isClean] = false;
            }
          }
        }
        next() {
          if (!this.parent) return void 0;
          let index = this.parent.index(this);
          return this.parent.nodes[index + 1];
        }
        positionBy(opts = {}) {
          let inputString = "document" in this.source.input ? this.source.input.document : this.source.input.css;
          let pos = {
            column: this.source.start.column,
            line: this.source.start.line,
            offset: sourceOffset(inputString, this.source.start)
          };
          if (opts.index) {
            pos = this.positionInside(opts.index);
          } else if (opts.word) {
            let stringRepresentation = inputString.slice(
              sourceOffset(inputString, this.source.start),
              sourceOffset(inputString, this.source.end)
            );
            let index = stringRepresentation.indexOf(opts.word);
            if (index !== -1) pos = this.positionInside(index);
          }
          return pos;
        }
        positionInside(index) {
          let column = this.source.start.column;
          let line = this.source.start.line;
          let inputString = "document" in this.source.input ? this.source.input.document : this.source.input.css;
          let offset = sourceOffset(inputString, this.source.start);
          let end = offset + index;
          for (let i2 = offset; i2 < end; i2++) {
            if (inputString[i2] === "\n") {
              column = 1;
              line += 1;
            } else {
              column += 1;
            }
          }
          return { column, line, offset: end };
        }
        prev() {
          if (!this.parent) return void 0;
          let index = this.parent.index(this);
          return this.parent.nodes[index - 1];
        }
        rangeBy(opts = {}) {
          let inputString = "document" in this.source.input ? this.source.input.document : this.source.input.css;
          let start = {
            column: this.source.start.column,
            line: this.source.start.line,
            offset: sourceOffset(inputString, this.source.start)
          };
          let end = this.source.end ? {
            column: this.source.end.column + 1,
            line: this.source.end.line,
            offset: typeof this.source.end.offset === "number" ? (
              // `source.end.offset` is exclusive, so we don't need to add 1
              this.source.end.offset
            ) : (
              // Since line/column in this.source.end is inclusive,
              // the `sourceOffset(... , this.source.end)` returns an inclusive offset.
              // So, we add 1 to convert it to exclusive.
              sourceOffset(inputString, this.source.end) + 1
            )
          } : {
            column: start.column + 1,
            line: start.line,
            offset: start.offset + 1
          };
          if (opts.word) {
            let stringRepresentation = inputString.slice(
              sourceOffset(inputString, this.source.start),
              sourceOffset(inputString, this.source.end)
            );
            let index = stringRepresentation.indexOf(opts.word);
            if (index !== -1) {
              start = this.positionInside(index);
              end = this.positionInside(index + opts.word.length);
            }
          } else {
            if (opts.start) {
              start = {
                column: opts.start.column,
                line: opts.start.line,
                offset: sourceOffset(inputString, opts.start)
              };
            } else if (typeof opts.index === "number") {
              start = this.positionInside(opts.index);
            }
            if (opts.end) {
              end = {
                column: opts.end.column,
                line: opts.end.line,
                offset: sourceOffset(inputString, opts.end)
              };
            } else if (typeof opts.endIndex === "number") {
              end = this.positionInside(opts.endIndex);
            } else if (typeof opts.index === "number") {
              end = this.positionInside(opts.index + 1);
            }
          }
          if (end.line < start.line || end.line === start.line && end.column <= start.column) {
            end = {
              column: start.column + 1,
              line: start.line,
              offset: start.offset + 1
            };
          }
          return { end, start };
        }
        raw(prop, defaultType) {
          let str = new Stringifier();
          return str.raw(this, prop, defaultType);
        }
        remove() {
          if (this.parent) {
            this.parent.removeChild(this);
          }
          this.parent = void 0;
          return this;
        }
        replaceWith(...nodes) {
          if (this.parent) {
            let bookmark = this;
            let foundSelf = false;
            for (let node of nodes) {
              if (node === this) {
                foundSelf = true;
              } else if (foundSelf) {
                this.parent.insertAfter(bookmark, node);
                bookmark = node;
              } else {
                this.parent.insertBefore(bookmark, node);
              }
            }
            if (!foundSelf) {
              this.remove();
            }
          }
          return this;
        }
        root() {
          let result = this;
          while (result.parent && result.parent.type !== "document") {
            result = result.parent;
          }
          return result;
        }
        toJSON(_2, inputs) {
          let emitInputs = inputs == null;
          inputs = inputs || /* @__PURE__ */ new Map();
          let holderOfRoot = [];
          let queue = [[this, holderOfRoot, 0]];
          for (let step = 0; step < queue.length; step++) {
            let [node, holder, key] = queue[step];
            let fixed2 = {};
            holder[key] = fixed2;
            for (let name in node) {
              if (!Object.prototype.hasOwnProperty.call(node, name)) {
                continue;
              }
              if (name === "parent" || name === "proxyCache") continue;
              let value = node[name];
              if (Array.isArray(value)) {
                let fixedArray = [];
                fixed2[name] = fixedArray;
                for (let i2 = 0; i2 < value.length; i2++) {
                  let item = value[i2];
                  if (typeof item === "object" && item.toJSON) {
                    if (item.toJSON === _Node.prototype.toJSON) {
                      queue.push([item, fixedArray, i2]);
                    } else {
                      fixedArray[i2] = item.toJSON(null, inputs);
                    }
                  } else {
                    fixedArray[i2] = item;
                  }
                }
              } else if (typeof value === "object" && value.toJSON) {
                if (value.toJSON === _Node.prototype.toJSON) {
                  queue.push([value, fixed2, name]);
                } else {
                  fixed2[name] = value.toJSON(null, inputs);
                }
              } else if (name === "source") {
                if (value == null) continue;
                let inputId = inputs.get(value.input);
                if (inputId == null) {
                  inputId = inputs.size;
                  inputs.set(value.input, inputId);
                }
                fixed2[name] = {
                  end: value.end,
                  inputId,
                  start: value.start
                };
              } else {
                fixed2[name] = value;
              }
            }
          }
          let fixed = holderOfRoot[0];
          if (emitInputs) {
            fixed.inputs = [...inputs.keys()].map((input) => input.toJSON());
          }
          return fixed;
        }
        toProxy() {
          if (!this.proxyCache) {
            this.proxyCache = new Proxy(this, this.getProxyProcessor());
          }
          return this.proxyCache;
        }
        toString(stringifier = stringify2) {
          if (stringifier.stringify) stringifier = stringifier.stringify;
          let result = "";
          stringifier(this, (i2) => {
            result += i2;
          });
          return result;
        }
        warn(result, text, opts = {}) {
          let data = { node: this };
          for (let i2 in opts) data[i2] = opts[i2];
          return result.warn(text, data);
        }
      };
      module.exports = Node3;
      Node3.default = Node3;
    }
  });

  // node_modules/postcss/lib/comment.js
  var require_comment = __commonJS({
    "node_modules/postcss/lib/comment.js"(exports, module) {
      "use strict";
      var Node3 = require_node();
      var Comment2 = class extends Node3 {
        constructor(defaults) {
          super(defaults);
          this.type = "comment";
        }
      };
      module.exports = Comment2;
      Comment2.default = Comment2;
    }
  });

  // node_modules/postcss/lib/declaration.js
  var require_declaration = __commonJS({
    "node_modules/postcss/lib/declaration.js"(exports, module) {
      "use strict";
      var Node3 = require_node();
      var Declaration2 = class extends Node3 {
        get variable() {
          return this.prop.startsWith("--") || this.prop[0] === "$";
        }
        constructor(defaults) {
          if (defaults && typeof defaults.value !== "undefined" && typeof defaults.value !== "string") {
            defaults = { ...defaults, value: String(defaults.value) };
          }
          super(defaults);
          this.type = "decl";
        }
      };
      module.exports = Declaration2;
      Declaration2.default = Declaration2;
    }
  });

  // node_modules/postcss/lib/container.js
  var require_container = __commonJS({
    "node_modules/postcss/lib/container.js"(exports, module) {
      "use strict";
      var Comment2 = require_comment();
      var Declaration2 = require_declaration();
      var Node3 = require_node();
      var { isClean, my } = require_symbols();
      var AtRule2;
      var parse2;
      var Root2;
      var Rule2;
      function cleanSource(nodes) {
        let stack = nodes.slice();
        while (stack.length > 0) {
          let node = stack.pop();
          delete node.source;
          if (node.nodes) {
            node.nodes = node.nodes.slice();
            for (let i2 of node.nodes) stack.push(i2);
          }
        }
        return nodes.slice();
      }
      function markTreeDirty(node) {
        let stack = [node];
        while (stack.length > 0) {
          let next = stack.pop();
          next[isClean] = false;
          if (next.proxyOf.nodes) {
            for (let i2 of next.proxyOf.nodes) stack.push(i2);
          }
        }
      }
      var Container2 = class _Container extends Node3 {
        get first() {
          if (!this.proxyOf.nodes) return void 0;
          return this.proxyOf.nodes[0];
        }
        get last() {
          if (!this.proxyOf.nodes) return void 0;
          return this.proxyOf.nodes[this.proxyOf.nodes.length - 1];
        }
        append(...children) {
          for (let child of children) {
            let nodes = this.normalize(child, this.last);
            for (let node of nodes) this.proxyOf.nodes.push(node);
          }
          this.markDirty();
          return this;
        }
        cleanRaws(keepBetween) {
          let stack = [this];
          while (stack.length > 0) {
            let node = stack.pop();
            if (node !== this && node.cleanRaws !== _Container.prototype.cleanRaws) {
              node.cleanRaws(keepBetween);
              continue;
            }
            Node3.prototype.cleanRaws.call(node, keepBetween);
            if (node.nodes) {
              for (let child of node.nodes) stack.push(child);
            }
          }
        }
        each(callback) {
          if (!this.proxyOf.nodes) return void 0;
          let iterator = this.getIterator();
          let index, result;
          while (this.indexes[iterator] < this.proxyOf.nodes.length) {
            index = this.indexes[iterator];
            result = callback(this.proxyOf.nodes[index], index);
            if (result === false) break;
            this.indexes[iterator] += 1;
          }
          delete this.indexes[iterator];
          return result;
        }
        every(condition) {
          return this.nodes.every(condition);
        }
        getIterator() {
          if (!this.lastEach) this.lastEach = 0;
          if (!this.indexes) this.indexes = {};
          this.lastEach += 1;
          let iterator = this.lastEach;
          this.indexes[iterator] = 0;
          return iterator;
        }
        getProxyProcessor() {
          return {
            get(node, prop) {
              if (prop === "proxyOf") {
                return node;
              } else if (!node[prop]) {
                return node[prop];
              } else if (prop === "each" || typeof prop === "string" && prop.startsWith("walk")) {
                return (...args) => {
                  return node[prop](
                    ...args.map((i2) => {
                      if (typeof i2 === "function") {
                        return (child, index) => i2(child.toProxy(), index);
                      } else {
                        return i2;
                      }
                    })
                  );
                };
              } else if (prop === "every" || prop === "some") {
                return (cb) => {
                  return node[prop](
                    (child, ...other) => cb(child.toProxy(), ...other)
                  );
                };
              } else if (prop === "root") {
                return () => node.root().toProxy();
              } else if (prop === "nodes") {
                return node.nodes.map((i2) => i2.toProxy());
              } else if (prop === "first" || prop === "last") {
                return node[prop].toProxy();
              } else {
                return node[prop];
              }
            },
            set(node, prop, value) {
              if (node[prop] === value) return true;
              node[prop] = value;
              if (prop === "name" || prop === "params" || prop === "selector") {
                node.markDirty();
              }
              return true;
            }
          };
        }
        index(child) {
          if (typeof child === "number") return child;
          if (child.proxyOf) child = child.proxyOf;
          return this.proxyOf.nodes.indexOf(child);
        }
        insertAfter(exist, add) {
          let existIndex = this.index(exist);
          let nodes = this.normalize(add, this.proxyOf.nodes[existIndex]).reverse();
          existIndex = this.index(exist);
          for (let node of nodes) this.proxyOf.nodes.splice(existIndex + 1, 0, node);
          let index;
          for (let id in this.indexes) {
            index = this.indexes[id];
            if (existIndex < index) {
              this.indexes[id] = index + nodes.length;
            }
          }
          this.markDirty();
          return this;
        }
        insertBefore(exist, add) {
          let existIndex = this.index(exist);
          let type = existIndex === 0 ? "prepend" : false;
          let nodes = this.normalize(
            add,
            this.proxyOf.nodes[existIndex],
            type
          ).reverse();
          existIndex = this.index(exist);
          for (let node of nodes) this.proxyOf.nodes.splice(existIndex, 0, node);
          let index;
          for (let id in this.indexes) {
            index = this.indexes[id];
            if (existIndex <= index) {
              this.indexes[id] = index + nodes.length;
            }
          }
          this.markDirty();
          return this;
        }
        normalize(nodes, sample) {
          if (typeof nodes === "string") {
            nodes = cleanSource(parse2(nodes).nodes);
          } else if (typeof nodes === "undefined") {
            nodes = [];
          } else if (Array.isArray(nodes)) {
            nodes = nodes.slice(0);
            for (let i2 of nodes) {
              if (i2.parent) i2.parent.removeChild(i2, "ignore");
            }
          } else if (nodes.type === "root" && this.type !== "document") {
            nodes = nodes.nodes.slice(0);
            for (let i2 of nodes) {
              if (i2.parent) i2.parent.removeChild(i2, "ignore");
            }
          } else if (nodes.type) {
            nodes = [nodes];
          } else if (nodes.prop) {
            if (typeof nodes.value === "undefined") {
              throw new Error("Value field is missed in node creation");
            } else if (typeof nodes.value !== "string") {
              nodes.value = String(nodes.value);
            }
            nodes = [new Declaration2(nodes)];
          } else if (nodes.selector || nodes.selectors) {
            nodes = [new Rule2(nodes)];
          } else if (nodes.name) {
            nodes = [new AtRule2(nodes)];
          } else if (nodes.text) {
            nodes = [new Comment2(nodes)];
          } else {
            throw new Error("Unknown node type in node creation");
          }
          let processed = nodes.map((i2) => {
            if (!i2[my]) _Container.rebuild(i2);
            i2 = i2.proxyOf;
            if (i2.parent) i2.parent.removeChild(i2);
            if (i2[isClean]) markTreeDirty(i2);
            if (!i2.raws) i2.raws = {};
            if (typeof i2.raws.before === "undefined") {
              if (sample && typeof sample.raws.before !== "undefined") {
                i2.raws.before = sample.raws.before.replace(/\S/g, "");
              }
            }
            i2.parent = this.proxyOf;
            return i2;
          });
          return processed;
        }
        prepend(...children) {
          children = children.reverse();
          for (let child of children) {
            let nodes = this.normalize(child, this.first, "prepend").reverse();
            for (let node of nodes) this.proxyOf.nodes.unshift(node);
            for (let id in this.indexes) {
              this.indexes[id] = this.indexes[id] + nodes.length;
            }
          }
          this.markDirty();
          return this;
        }
        push(child) {
          child.parent = this;
          this.proxyOf.nodes.push(child);
          return this;
        }
        removeAll() {
          for (let node of this.proxyOf.nodes) node.parent = void 0;
          this.proxyOf.nodes = [];
          this.markDirty();
          return this;
        }
        removeChild(child) {
          child = this.index(child);
          this.proxyOf.nodes[child].parent = void 0;
          this.proxyOf.nodes.splice(child, 1);
          let index;
          for (let id in this.indexes) {
            index = this.indexes[id];
            if (index >= child) {
              this.indexes[id] = index - 1;
            }
          }
          this.markDirty();
          return this;
        }
        replaceValues(pattern, opts, callback) {
          if (!callback) {
            callback = opts;
            opts = {};
          }
          this.walkDecls((decl2) => {
            if (opts.props && !opts.props.includes(decl2.prop)) return;
            if (opts.fast && !decl2.value.includes(opts.fast)) return;
            decl2.value = decl2.value.replace(pattern, callback);
          });
          this.markDirty();
          return this;
        }
        some(condition) {
          return this.nodes.some(condition);
        }
        walk(callback) {
          if (!this.proxyOf.nodes) return void 0;
          let stack = [{ iterator: this.getIterator(), node: this.proxyOf }];
          while (stack.length > 0) {
            let { iterator, node } = stack[stack.length - 1];
            let index = node.indexes[iterator];
            if (index >= node.proxyOf.nodes.length) {
              delete node.indexes[iterator];
              stack.pop();
              let parent = stack[stack.length - 1];
              if (parent) parent.node.indexes[parent.iterator] += 1;
              continue;
            }
            let child = node.proxyOf.nodes[index];
            let result;
            try {
              result = callback(child, index);
            } catch (e4) {
              throw child.addToError(e4);
            }
            if (result === false) {
              for (let opened of stack) {
                delete opened.node.indexes[opened.iterator];
              }
              return false;
            }
            if (child.walk && child.proxyOf.nodes) {
              stack.push({ iterator: child.getIterator(), node: child });
            } else {
              node.indexes[iterator] += 1;
            }
          }
          return void 0;
        }
        walkAtRules(name, callback) {
          if (!callback) {
            callback = name;
            return this.walk((child, i2) => {
              if (child.type === "atrule") {
                return callback(child, i2);
              }
            });
          }
          if (name instanceof RegExp) {
            return this.walk((child, i2) => {
              if (child.type === "atrule" && name.test(child.name)) {
                return callback(child, i2);
              }
            });
          }
          return this.walk((child, i2) => {
            if (child.type === "atrule" && child.name === name) {
              return callback(child, i2);
            }
          });
        }
        walkComments(callback) {
          return this.walk((child, i2) => {
            if (child.type === "comment") {
              return callback(child, i2);
            }
          });
        }
        walkDecls(prop, callback) {
          if (!callback) {
            callback = prop;
            return this.walk((child, i2) => {
              if (child.type === "decl") {
                return callback(child, i2);
              }
            });
          }
          if (prop instanceof RegExp) {
            return this.walk((child, i2) => {
              if (child.type === "decl" && prop.test(child.prop)) {
                return callback(child, i2);
              }
            });
          }
          return this.walk((child, i2) => {
            if (child.type === "decl" && child.prop === prop) {
              return callback(child, i2);
            }
          });
        }
        walkRules(selector, callback) {
          if (!callback) {
            callback = selector;
            return this.walk((child, i2) => {
              if (child.type === "rule") {
                return callback(child, i2);
              }
            });
          }
          if (selector instanceof RegExp) {
            return this.walk((child, i2) => {
              if (child.type === "rule" && selector.test(child.selector)) {
                return callback(child, i2);
              }
            });
          }
          return this.walk((child, i2) => {
            if (child.type === "rule" && child.selector === selector) {
              return callback(child, i2);
            }
          });
        }
      };
      Container2.registerParse = (dependant) => {
        parse2 = dependant;
      };
      Container2.registerRule = (dependant) => {
        Rule2 = dependant;
      };
      Container2.registerAtRule = (dependant) => {
        AtRule2 = dependant;
      };
      Container2.registerRoot = (dependant) => {
        Root2 = dependant;
      };
      module.exports = Container2;
      Container2.default = Container2;
      Container2.rebuild = (node) => {
        let stack = [node];
        while (stack.length > 0) {
          let next = stack.pop();
          if (next.type === "atrule") {
            Object.setPrototypeOf(next, AtRule2.prototype);
          } else if (next.type === "rule") {
            Object.setPrototypeOf(next, Rule2.prototype);
          } else if (next.type === "decl") {
            Object.setPrototypeOf(next, Declaration2.prototype);
          } else if (next.type === "comment") {
            Object.setPrototypeOf(next, Comment2.prototype);
          } else if (next.type === "root") {
            Object.setPrototypeOf(next, Root2.prototype);
          }
          next[my] = true;
          if (next.nodes) {
            for (let child of next.nodes) stack.push(child);
          }
        }
      };
    }
  });

  // node_modules/postcss/lib/at-rule.js
  var require_at_rule = __commonJS({
    "node_modules/postcss/lib/at-rule.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var AtRule2 = class extends Container2 {
        constructor(defaults) {
          super(defaults);
          this.type = "atrule";
        }
        append(...children) {
          if (!this.proxyOf.nodes) this.nodes = [];
          return super.append(...children);
        }
        prepend(...children) {
          if (!this.proxyOf.nodes) this.nodes = [];
          return super.prepend(...children);
        }
      };
      module.exports = AtRule2;
      AtRule2.default = AtRule2;
      Container2.registerAtRule(AtRule2);
    }
  });

  // node_modules/postcss/lib/document.js
  var require_document = __commonJS({
    "node_modules/postcss/lib/document.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var LazyResult;
      var Processor2;
      var Document2 = class extends Container2 {
        constructor(defaults) {
          super({ type: "document", ...defaults });
          if (!this.nodes) {
            this.nodes = [];
          }
        }
        toResult(opts = {}) {
          let lazy = new LazyResult(new Processor2(), this, opts);
          return lazy.stringify();
        }
      };
      Document2.registerLazyResult = (dependant) => {
        LazyResult = dependant;
      };
      Document2.registerProcessor = (dependant) => {
        Processor2 = dependant;
      };
      module.exports = Document2;
      Document2.default = Document2;
    }
  });

  // node_modules/nanoid/non-secure/index.cjs
  var require_non_secure = __commonJS({
    "node_modules/nanoid/non-secure/index.cjs"(exports, module) {
      var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
      var customAlphabet = (alphabet, defaultSize = 21) => {
        return (size = defaultSize) => {
          let id = "";
          let i2 = size | 0;
          while (i2-- > 0) {
            id += alphabet[Math.random() * alphabet.length | 0];
          }
          return id;
        };
      };
      var nanoid = (size = 21) => {
        let id = "";
        let i2 = size | 0;
        while (i2-- > 0) {
          id += urlAlphabet[Math.random() * 64 | 0];
        }
        return id;
      };
      module.exports = { nanoid, customAlphabet };
    }
  });

  // (disabled):path
  var require_path = __commonJS({
    "(disabled):path"() {
    }
  });

  // (disabled):node_modules/source-map-js/source-map.js
  var require_source_map = __commonJS({
    "(disabled):node_modules/source-map-js/source-map.js"() {
    }
  });

  // (disabled):url
  var require_url = __commonJS({
    "(disabled):url"() {
    }
  });

  // (disabled):fs
  var require_fs = __commonJS({
    "(disabled):fs"() {
    }
  });

  // node_modules/postcss/lib/previous-map.js
  var require_previous_map = __commonJS({
    "node_modules/postcss/lib/previous-map.js"(exports, module) {
      "use strict";
      var { existsSync, readFileSync } = require_fs();
      var { dirname, isAbsolute, join, relative, sep } = require_path();
      var { SourceMapConsumer, SourceMapGenerator } = require_source_map();
      function fromBase64(str) {
        if (Buffer) {
          return Buffer.from(str, "base64").toString();
        } else {
          return window.atob(str);
        }
      }
      var PreviousMap = class {
        constructor(css, opts) {
          if (opts.map === false) return;
          if (opts.unsafeMap) this.unsafeMap = true;
          this.loadAnnotation(css);
          this.inline = this.startWith(this.annotation, "data:");
          let prev = opts.map ? opts.map.prev : void 0;
          let text = this.loadMap(opts.from, prev);
          if (!this.mapFile && opts.from) {
            this.mapFile = opts.from;
          }
          if (this.mapFile) this.root = dirname(this.mapFile);
          if (text) this.text = text;
        }
        consumer() {
          if (!this.consumerCache) {
            this.consumerCache = new SourceMapConsumer(this.json || this.text);
          }
          return this.consumerCache;
        }
        decodeInline(text) {
          let baseCharsetUri = /^data:application\/json;charset=utf-?8;base64,/;
          let baseUri = /^data:application\/json;base64,/;
          let charsetUri = /^data:application\/json;charset=utf-?8,/;
          let uri = /^data:application\/json,/;
          let uriMatch = text.match(charsetUri) || text.match(uri);
          if (uriMatch) {
            return decodeURIComponent(text.substr(uriMatch[0].length));
          }
          let baseUriMatch = text.match(baseCharsetUri) || text.match(baseUri);
          if (baseUriMatch) {
            return fromBase64(text.substr(baseUriMatch[0].length));
          }
          let encoding = text.slice("data:application/json;".length);
          encoding = encoding.slice(0, encoding.indexOf(","));
          throw new Error("Unsupported source map encoding " + encoding);
        }
        getAnnotationURL(sourceMapString) {
          return sourceMapString.replace(/^\/\*\s*# sourceMappingURL=/, "").trim();
        }
        isMap(map) {
          if (typeof map !== "object") return false;
          return typeof map.mappings === "string" || typeof map._mappings === "string" || Array.isArray(map.sections);
        }
        loadAnnotation(css) {
          let comments = css.match(/\/\*\s*# sourceMappingURL=/g);
          if (!comments) return;
          let start = css.lastIndexOf(comments.pop());
          let end = css.indexOf("*/", start);
          if (start > -1 && end > -1) {
            this.annotation = this.getAnnotationURL(css.substring(start, end));
          }
        }
        loadFile(path, cssFile, trusted) {
          if (!trusted && !this.unsafeMap) {
            if (!/\.map$/i.test(path)) return void 0;
            if (!cssFile) return void 0;
            let rel = relative(dirname(cssFile), path);
            if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
              return void 0;
            }
          }
          this.root = dirname(path);
          if (existsSync(path)) {
            this.mapFile = path;
            return readFileSync(path, "utf-8").toString().trim();
          }
        }
        loadMap(file, prev) {
          if (prev === false) return false;
          if (prev) {
            if (typeof prev === "string") {
              return prev;
            } else if (typeof prev === "function") {
              let prevPath = prev(file);
              if (prevPath) {
                let map = this.loadFile(prevPath, file, true);
                if (!map) {
                  throw new Error(
                    "Unable to load previous source map: " + prevPath.toString()
                  );
                }
                return map;
              }
            } else if (prev instanceof SourceMapConsumer) {
              return SourceMapGenerator.fromSourceMap(prev).toString();
            } else if (prev instanceof SourceMapGenerator) {
              return prev.toString();
            } else if (this.isMap(prev)) {
              return JSON.stringify(prev);
            } else {
              throw new Error(
                "Unsupported previous source map format: " + prev.toString()
              );
            }
          } else if (this.inline) {
            return this.decodeInline(this.annotation);
          } else if (this.annotation) {
            let map = this.annotation;
            if (file) map = join(dirname(file), map);
            let unknown = this.loadFile(map, file, false);
            if (unknown) {
              try {
                this.json = JSON.parse(unknown.replace(/^\)]}'[^\n]*\n/, ""));
              } catch {
                return void 0;
              }
            }
            return unknown;
          }
        }
        startWith(string, start) {
          if (!string) return false;
          return string.substr(0, start.length) === start;
        }
        withContent() {
          return !!(this.consumer().sourcesContent && this.consumer().sourcesContent.length > 0);
        }
      };
      module.exports = PreviousMap;
      PreviousMap.default = PreviousMap;
    }
  });

  // node_modules/postcss/lib/input.js
  var require_input = __commonJS({
    "node_modules/postcss/lib/input.js"(exports, module) {
      "use strict";
      var { nanoid } = require_non_secure();
      var { isAbsolute, resolve } = require_path();
      var { SourceMapConsumer, SourceMapGenerator } = require_source_map();
      var { fileURLToPath, pathToFileURL } = require_url();
      var CssSyntaxError2 = require_css_syntax_error();
      var PreviousMap = require_previous_map();
      var terminalHighlight = require_terminal_highlight();
      var lineToIndexCache = /* @__PURE__ */ Symbol("lineToIndexCache");
      var sourceMapAvailable = Boolean(SourceMapConsumer && SourceMapGenerator);
      var pathAvailable = Boolean(resolve && isAbsolute);
      function getLineToIndex(input) {
        if (input[lineToIndexCache]) return input[lineToIndexCache];
        let lines = input.css.split("\n");
        let lineToIndex = new Array(lines.length);
        let prevIndex = 0;
        for (let i2 = 0, l2 = lines.length; i2 < l2; i2++) {
          lineToIndex[i2] = prevIndex;
          prevIndex += lines[i2].length + 1;
        }
        input[lineToIndexCache] = lineToIndex;
        return lineToIndex;
      }
      var Input2 = class {
        get from() {
          return this.file || this.id;
        }
        constructor(css, opts = {}) {
          if (css === null || typeof css === "undefined" || typeof css === "object" && !css.toString) {
            throw new Error(`PostCSS received ${css} instead of CSS string`);
          }
          this.css = css.toString();
          if (this.css[0] === "\uFEFF" || this.css[0] === "\uFFFE") {
            this.hasBOM = true;
            this.css = this.css.slice(1);
          } else {
            this.hasBOM = false;
          }
          this.document = this.css;
          if (opts.document) this.document = opts.document.toString();
          if (opts.from) {
            if (!pathAvailable || /^\w+:\/\//.test(opts.from) || isAbsolute(opts.from)) {
              this.file = opts.from;
            } else {
              this.file = resolve(opts.from);
            }
          }
          if (pathAvailable && sourceMapAvailable) {
            let map = new PreviousMap(this.css, opts);
            if (map.text) {
              this.map = map;
              let file = map.consumer().file;
              if (!this.file && file) this.file = this.mapResolve(file);
            }
          }
          if (!this.file) {
            this.id = "<input css " + nanoid(6) + ">";
          }
          if (this.map) this.map.file = this.from;
        }
        error(message, line, column, opts = {}) {
          let endColumn, endLine, endOffset, offset, result;
          if (line && typeof line === "object") {
            let start = line;
            let end = column;
            if (typeof start.offset === "number") {
              offset = start.offset;
              let pos = this.fromOffset(offset);
              line = pos.line;
              column = pos.col;
            } else {
              line = start.line;
              column = start.column;
              offset = this.fromLineAndColumn(line, column);
            }
            if (typeof end.offset === "number") {
              endOffset = end.offset;
              let pos = this.fromOffset(endOffset);
              endLine = pos.line;
              endColumn = pos.col;
            } else {
              endLine = end.line;
              endColumn = end.column;
              endOffset = this.fromLineAndColumn(end.line, end.column);
            }
          } else if (!column) {
            offset = line;
            let pos = this.fromOffset(offset);
            line = pos.line;
            column = pos.col;
          } else {
            offset = this.fromLineAndColumn(line, column);
          }
          let origin = this.origin(line, column, endLine, endColumn);
          if (origin) {
            result = new CssSyntaxError2(
              message,
              origin.endLine === void 0 ? origin.line : { column: origin.column, line: origin.line },
              origin.endLine === void 0 ? origin.column : { column: origin.endColumn, line: origin.endLine },
              origin.source,
              origin.file,
              opts.plugin
            );
          } else {
            result = new CssSyntaxError2(
              message,
              endLine === void 0 ? line : { column, line },
              endLine === void 0 ? column : { column: endColumn, line: endLine },
              this.css,
              this.file,
              opts.plugin
            );
          }
          result.input = {
            column,
            endColumn,
            endLine,
            endOffset,
            line,
            offset,
            source: this.css
          };
          if (this.file) {
            if (pathToFileURL) {
              result.input.url = pathToFileURL(this.file).toString();
            }
            result.input.file = this.file;
          }
          return result;
        }
        fromLineAndColumn(line, column) {
          let lineToIndex = getLineToIndex(this);
          let index = lineToIndex[line - 1];
          return index + column - 1;
        }
        fromOffset(offset) {
          let lineToIndex = getLineToIndex(this);
          let lastLine = lineToIndex[lineToIndex.length - 1];
          let min = 0;
          if (offset >= lastLine) {
            min = lineToIndex.length - 1;
          } else {
            let max = lineToIndex.length - 2;
            let mid;
            while (min < max) {
              mid = min + (max - min >> 1);
              if (offset < lineToIndex[mid]) {
                max = mid - 1;
              } else if (offset >= lineToIndex[mid + 1]) {
                min = mid + 1;
              } else {
                min = mid;
                break;
              }
            }
          }
          return {
            col: offset - lineToIndex[min] + 1,
            line: min + 1
          };
        }
        mapResolve(file) {
          if (/^\w+:\/\//.test(file)) {
            return file;
          }
          return resolve(this.map.consumer().sourceRoot || this.map.root || ".", file);
        }
        origin(line, column, endLine, endColumn) {
          if (!this.map) return false;
          let consumer = this.map.consumer();
          let from = consumer.originalPositionFor({ column: column - 1, line });
          if (!from.source) return false;
          let to;
          if (typeof endLine === "number") {
            let toPosition = consumer.originalPositionFor({
              column: endColumn - 1,
              line: endLine
            });
            if (toPosition.source) to = toPosition;
          }
          let fromUrl;
          if (isAbsolute(from.source)) {
            fromUrl = pathToFileURL(from.source);
          } else {
            fromUrl = new URL(
              from.source,
              this.map.consumer().sourceRoot || pathToFileURL(this.map.mapFile)
            );
          }
          let result = {
            column: from.column + 1,
            endColumn: to && to.column + 1,
            endLine: to && to.line,
            line: from.line,
            url: fromUrl.toString()
          };
          if (fromUrl.protocol === "file:") {
            if (fileURLToPath) {
              result.file = fileURLToPath(fromUrl);
            } else {
              throw new Error(`file: protocol is not available in this PostCSS build`);
            }
          }
          let source = consumer.sourceContentFor(from.source);
          if (source) result.source = source;
          return result;
        }
        toJSON() {
          let json = {};
          for (let name of ["hasBOM", "css", "file", "id"]) {
            if (this[name] != null) {
              json[name] = this[name];
            }
          }
          if (this.map) {
            json.map = { ...this.map };
            if (json.map.consumerCache) {
              json.map.consumerCache = void 0;
            }
          }
          return json;
        }
      };
      module.exports = Input2;
      Input2.default = Input2;
      if (terminalHighlight && terminalHighlight.registerInput) {
        terminalHighlight.registerInput(Input2);
      }
    }
  });

  // node_modules/postcss/lib/root.js
  var require_root = __commonJS({
    "node_modules/postcss/lib/root.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var LazyResult;
      var Processor2;
      var Root2 = class extends Container2 {
        constructor(defaults) {
          super(defaults);
          this.type = "root";
          if (!this.nodes) this.nodes = [];
        }
        normalize(child, sample, type) {
          let keepBefore = /* @__PURE__ */ new Set();
          for (let node of Array.isArray(child) ? child : [child]) {
            if (node && typeof node === "object" && !node.parent && node.raws && typeof node.raws.before !== "undefined") {
              keepBefore.add(node.raws);
            }
          }
          let nodes = super.normalize(child);
          if (sample) {
            if (type === "prepend") {
              if (this.nodes.length > 1) {
                sample.raws.before = this.nodes[1].raws.before;
              } else {
                delete sample.raws.before;
              }
            } else if (this.first !== sample) {
              for (let node of nodes) {
                if (!keepBefore.has(node.raws)) {
                  node.raws.before = sample.raws.before;
                }
              }
            }
          }
          return nodes;
        }
        removeChild(child, ignore) {
          let index = this.index(child);
          if (!ignore && index === 0 && this.nodes.length > 1) {
            this.nodes[1].raws.before = this.nodes[index].raws.before;
          }
          return super.removeChild(child);
        }
        toResult(opts = {}) {
          let lazy = new LazyResult(new Processor2(), this, opts);
          return lazy.stringify();
        }
      };
      Root2.registerLazyResult = (dependant) => {
        LazyResult = dependant;
      };
      Root2.registerProcessor = (dependant) => {
        Processor2 = dependant;
      };
      module.exports = Root2;
      Root2.default = Root2;
      Container2.registerRoot(Root2);
    }
  });

  // node_modules/postcss/lib/list.js
  var require_list = __commonJS({
    "node_modules/postcss/lib/list.js"(exports, module) {
      "use strict";
      var list2 = {
        comma(string) {
          return list2.split(string, [","], true);
        },
        space(string) {
          let spaces = [" ", "\n", "	"];
          return list2.split(string, spaces);
        },
        split(string, separators, last) {
          if (!string) return [];
          let array = [];
          let current = "";
          let split = false;
          let func = 0;
          let inQuote = false;
          let prevQuote = "";
          let escape = false;
          for (let letter of string) {
            if (escape) {
              escape = false;
            } else if (letter === "\\") {
              escape = true;
            } else if (inQuote) {
              if (letter === prevQuote) {
                inQuote = false;
              }
            } else if (letter === '"' || letter === "'") {
              inQuote = true;
              prevQuote = letter;
            } else if (letter === "(") {
              func += 1;
            } else if (letter === ")") {
              if (func > 0) func -= 1;
            } else if (func === 0) {
              if (separators.includes(letter)) split = true;
            }
            if (split) {
              if (current !== "") array.push(current.trim());
              current = "";
              split = false;
            } else {
              current += letter;
            }
          }
          if (last || current !== "") array.push(current.trim());
          return array;
        }
      };
      module.exports = list2;
      list2.default = list2;
    }
  });

  // node_modules/postcss/lib/rule.js
  var require_rule = __commonJS({
    "node_modules/postcss/lib/rule.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var list2 = require_list();
      var Rule2 = class extends Container2 {
        get selectors() {
          return list2.comma(this.selector);
        }
        set selectors(values) {
          let match = this.selector ? this.selector.match(/,\s*/) : null;
          let sep = match ? match[0] : "," + this.raw("between", "beforeOpen");
          this.selector = values.join(sep);
        }
        constructor(defaults) {
          super(defaults);
          this.type = "rule";
          if (!this.nodes) this.nodes = [];
        }
      };
      module.exports = Rule2;
      Rule2.default = Rule2;
      Container2.registerRule(Rule2);
    }
  });

  // node_modules/postcss/lib/fromJSON.js
  var require_fromJSON = __commonJS({
    "node_modules/postcss/lib/fromJSON.js"(exports, module) {
      "use strict";
      var AtRule2 = require_at_rule();
      var Comment2 = require_comment();
      var Declaration2 = require_declaration();
      var Input2 = require_input();
      var PreviousMap = require_previous_map();
      var Root2 = require_root();
      var Rule2 = require_rule();
      function hydrateInputs(json, inputs) {
        if (!json.inputs) return inputs;
        return json.inputs.map((input) => {
          let inputHydrated = { ...input, __proto__: Input2.prototype };
          if (inputHydrated.map) {
            inputHydrated.map = {
              ...inputHydrated.map,
              __proto__: PreviousMap.prototype
            };
          }
          return inputHydrated;
        });
      }
      function constructNode(json, inputs, children) {
        let defaults = { ...json };
        delete defaults.inputs;
        delete defaults.nodes;
        if (defaults.source) {
          let { inputId, ...source } = defaults.source;
          defaults.source = source;
          if (inputId != null) {
            defaults.source.input = inputs[inputId];
          }
        }
        let node;
        if (defaults.type === "root") {
          node = new Root2(defaults);
        } else if (defaults.type === "decl") {
          node = new Declaration2(defaults);
        } else if (defaults.type === "rule") {
          node = new Rule2(defaults);
        } else if (defaults.type === "comment") {
          node = new Comment2(defaults);
        } else if (defaults.type === "atrule") {
          node = new AtRule2(defaults);
        } else {
          throw new Error("Unknown node type: " + json.type);
        }
        if (children) {
          node.nodes = children;
          for (let child of children) child.parent = node;
        }
        return node;
      }
      function fromJSON2(json, inputs) {
        if (Array.isArray(json)) return json.map((n2) => fromJSON2(n2));
        let result;
        let stack = [
          { childIndex: 0, children: [], inputs: hydrateInputs(json, inputs), json }
        ];
        while (stack.length > 0) {
          let frame = stack[stack.length - 1];
          let jsonNodes = frame.json.nodes;
          if (jsonNodes && frame.childIndex < jsonNodes.length) {
            let childJson = jsonNodes[frame.childIndex];
            frame.childIndex += 1;
            stack.push({
              childIndex: 0,
              children: [],
              inputs: hydrateInputs(childJson, frame.inputs),
              json: childJson
            });
            continue;
          }
          stack.pop();
          let node = constructNode(
            frame.json,
            frame.inputs,
            jsonNodes ? frame.children : void 0
          );
          if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
          } else {
            result = node;
          }
        }
        return result;
      }
      module.exports = fromJSON2;
      fromJSON2.default = fromJSON2;
    }
  });

  // node_modules/postcss/lib/map-generator.js
  var require_map_generator = __commonJS({
    "node_modules/postcss/lib/map-generator.js"(exports, module) {
      "use strict";
      var { dirname, relative, resolve, sep } = require_path();
      var { SourceMapConsumer, SourceMapGenerator } = require_source_map();
      var { pathToFileURL } = require_url();
      var Input2 = require_input();
      var sourceMapAvailable = Boolean(SourceMapConsumer && SourceMapGenerator);
      var pathAvailable = Boolean(dirname && resolve && relative && sep);
      var MapGenerator = class {
        constructor(stringify2, root2, opts, cssString) {
          this.stringify = stringify2;
          this.mapOpts = opts.map || {};
          this.root = root2;
          this.opts = opts;
          this.css = cssString;
          this.originalCSS = cssString;
          this.usesFileUrls = !this.mapOpts.from && this.mapOpts.absolute;
          this.memoizedFileURLs = /* @__PURE__ */ new Map();
          this.memoizedPaths = /* @__PURE__ */ new Map();
          this.memoizedURLs = /* @__PURE__ */ new Map();
        }
        addAnnotation() {
          let content;
          if (this.isInline()) {
            content = "data:application/json;base64," + this.toBase64(this.map.toString());
          } else if (typeof this.mapOpts.annotation === "string") {
            content = this.mapOpts.annotation;
          } else if (typeof this.mapOpts.annotation === "function") {
            content = this.mapOpts.annotation(this.opts.to, this.root);
          } else {
            content = this.outputFile() + ".map";
          }
          let eol = "\n";
          if (this.css.includes("\r\n")) eol = "\r\n";
          this.css += eol + "/*# sourceMappingURL=" + content + " */";
        }
        applyPrevMaps() {
          for (let prev of this.previous()) {
            let from = this.toUrl(this.path(prev.file));
            let root2 = prev.root || dirname(prev.file);
            let map;
            if (this.mapOpts.sourcesContent === false) {
              map = new SourceMapConsumer(prev.text);
              if (map.sourcesContent) {
                map.sourcesContent = null;
              }
            } else {
              map = prev.consumer();
            }
            this.map.applySourceMap(map, from, this.toUrl(this.path(root2)));
          }
        }
        clearAnnotation() {
          if (this.mapOpts.annotation === false) return;
          if (this.root) {
            let node;
            for (let i2 = this.root.nodes.length - 1; i2 >= 0; i2--) {
              node = this.root.nodes[i2];
              if (node.type !== "comment") continue;
              if (node.text.startsWith("# sourceMappingURL=")) {
                this.root.removeChild(i2);
              }
            }
          } else if (this.css) {
            let startIndex;
            while ((startIndex = this.css.lastIndexOf("/*#")) !== -1) {
              let endIndex = this.css.indexOf("*/", startIndex + 3);
              if (endIndex === -1) break;
              while (startIndex > 0 && this.css[startIndex - 1] === "\n") {
                startIndex--;
              }
              this.css = this.css.slice(0, startIndex) + this.css.slice(endIndex + 2);
            }
          }
        }
        generate() {
          this.clearAnnotation();
          if (pathAvailable && sourceMapAvailable && this.isMap()) {
            return this.generateMap();
          } else {
            let result = "";
            this.stringify(this.root, (i2) => {
              result += i2;
            });
            return [result];
          }
        }
        generateMap() {
          if (this.root) {
            this.generateString();
          } else if (this.previous().length === 1) {
            let prev = this.previous()[0].consumer();
            prev.file = this.outputFile();
            this.map = SourceMapGenerator.fromSourceMap(prev, {
              ignoreInvalidMapping: true
            });
          } else {
            this.map = new SourceMapGenerator({
              file: this.outputFile(),
              ignoreInvalidMapping: true
            });
            this.map.addMapping({
              generated: { column: 0, line: 1 },
              original: { column: 0, line: 1 },
              source: this.opts.from ? this.toUrl(this.path(this.opts.from)) : "<no source>"
            });
          }
          if (this.isSourcesContent()) this.setSourcesContent();
          if (this.root && this.previous().length > 0) this.applyPrevMaps();
          if (this.isAnnotation()) this.addAnnotation();
          if (this.isInline()) {
            return [this.css];
          } else {
            return [this.css, this.map];
          }
        }
        generateString() {
          this.css = "";
          this.map = new SourceMapGenerator({
            file: this.outputFile(),
            ignoreInvalidMapping: true
          });
          let line = 1;
          let column = 1;
          let noSource = "<no source>";
          let mapping = {
            generated: { column: 0, line: 0 },
            original: { column: 0, line: 0 },
            source: ""
          };
          let last, lines;
          this.stringify(this.root, (str, node, type) => {
            this.css += str;
            if (node && type !== "end") {
              mapping.generated.line = line;
              mapping.generated.column = column - 1;
              if (node.source && node.source.start) {
                mapping.source = this.sourcePath(node);
                mapping.original.line = node.source.start.line;
                mapping.original.column = node.source.start.column - 1;
                this.map.addMapping(mapping);
              } else {
                mapping.source = noSource;
                mapping.original.line = 1;
                mapping.original.column = 0;
                this.map.addMapping(mapping);
              }
            }
            lines = str.match(/\n/g);
            if (lines) {
              line += lines.length;
              last = str.lastIndexOf("\n");
              column = str.length - last;
            } else {
              column += str.length;
            }
            if (node && type !== "start") {
              let p2 = node.parent || { raws: {} };
              let childless = node.type === "decl" || node.type === "atrule" && !node.nodes;
              if (!childless || node !== p2.last || p2.raws.semicolon) {
                if (node.source && node.source.end) {
                  mapping.source = this.sourcePath(node);
                  mapping.original.line = node.source.end.line;
                  mapping.original.column = node.source.end.column - 1;
                  mapping.generated.line = line;
                  mapping.generated.column = column - 2;
                  this.map.addMapping(mapping);
                } else {
                  mapping.source = noSource;
                  mapping.original.line = 1;
                  mapping.original.column = 0;
                  mapping.generated.line = line;
                  mapping.generated.column = column - 1;
                  this.map.addMapping(mapping);
                }
              }
            }
          });
        }
        isAnnotation() {
          if (this.isInline()) {
            return true;
          }
          if (typeof this.mapOpts.annotation !== "undefined") {
            return this.mapOpts.annotation;
          }
          if (this.previous().length) {
            return this.previous().some((i2) => i2.annotation);
          }
          return true;
        }
        isInline() {
          if (typeof this.mapOpts.inline !== "undefined") {
            return this.mapOpts.inline;
          }
          let annotation = this.mapOpts.annotation;
          if (typeof annotation !== "undefined" && annotation !== true) {
            return false;
          }
          if (this.previous().length) {
            return this.previous().some((i2) => i2.inline);
          }
          return true;
        }
        isMap() {
          if (typeof this.opts.map !== "undefined") {
            return !!this.opts.map;
          }
          return this.previous().length > 0;
        }
        isSourcesContent() {
          if (typeof this.mapOpts.sourcesContent !== "undefined") {
            return this.mapOpts.sourcesContent;
          }
          if (this.previous().length) {
            return this.previous().some((i2) => i2.withContent());
          }
          return true;
        }
        outputFile() {
          if (this.opts.to) {
            return this.path(this.opts.to);
          } else if (this.opts.from) {
            return this.path(this.opts.from);
          } else {
            return "to.css";
          }
        }
        path(file) {
          if (this.mapOpts.absolute) return file;
          if (file.charCodeAt(0) === 60) return file;
          if (/^\w+:\/\//.test(file)) return file;
          let cached = this.memoizedPaths.get(file);
          if (cached) return cached;
          let from = this.opts.to ? dirname(this.opts.to) : ".";
          if (typeof this.mapOpts.annotation === "string") {
            from = dirname(resolve(from, this.mapOpts.annotation));
          }
          let path = relative(from, file);
          this.memoizedPaths.set(file, path);
          return path;
        }
        previous() {
          if (!this.previousMaps) {
            this.previousMaps = [];
            if (this.root) {
              this.root.walk((node) => {
                if (node.source && node.source.input.map) {
                  let map = node.source.input.map;
                  if (!this.previousMaps.includes(map)) {
                    this.previousMaps.push(map);
                  }
                }
              });
            } else {
              let input = new Input2(this.originalCSS, this.opts);
              if (input.map) this.previousMaps.push(input.map);
            }
          }
          return this.previousMaps;
        }
        setSourcesContent() {
          let already = {};
          if (this.root) {
            this.root.walk((node) => {
              if (node.source) {
                let from = node.source.input.from;
                if (from && !already[from]) {
                  already[from] = true;
                  let fromUrl = this.usesFileUrls ? this.toFileUrl(from) : this.toUrl(this.path(from));
                  this.map.setSourceContent(fromUrl, node.source.input.css);
                }
              }
            });
          } else if (this.css) {
            let from = this.opts.from ? this.toUrl(this.path(this.opts.from)) : "<no source>";
            this.map.setSourceContent(from, this.css);
          }
        }
        sourcePath(node) {
          if (this.mapOpts.from) {
            return this.toUrl(this.mapOpts.from);
          } else if (this.usesFileUrls) {
            return this.toFileUrl(node.source.input.from);
          } else {
            return this.toUrl(this.path(node.source.input.from));
          }
        }
        toBase64(str) {
          if (Buffer) {
            return Buffer.from(str).toString("base64");
          } else {
            return window.btoa(unescape(encodeURIComponent(str)));
          }
        }
        toFileUrl(path) {
          let cached = this.memoizedFileURLs.get(path);
          if (cached) return cached;
          if (pathToFileURL) {
            let fileURL = pathToFileURL(path).toString();
            this.memoizedFileURLs.set(path, fileURL);
            return fileURL;
          } else {
            throw new Error(
              "`map.absolute` option is not available in this PostCSS build"
            );
          }
        }
        toUrl(path) {
          let cached = this.memoizedURLs.get(path);
          if (cached) return cached;
          if (sep === "\\") {
            path = path.replace(/\\/g, "/");
          }
          let url = encodeURI(path).replace(/[#?]/g, encodeURIComponent);
          this.memoizedURLs.set(path, url);
          return url;
        }
      };
      module.exports = MapGenerator;
    }
  });

  // node_modules/postcss/lib/tokenize.js
  var require_tokenize = __commonJS({
    "node_modules/postcss/lib/tokenize.js"(exports, module) {
      "use strict";
      var SINGLE_QUOTE = "'".charCodeAt(0);
      var DOUBLE_QUOTE = '"'.charCodeAt(0);
      var BACKSLASH = "\\".charCodeAt(0);
      var SLASH = "/".charCodeAt(0);
      var NEWLINE = "\n".charCodeAt(0);
      var SPACE = " ".charCodeAt(0);
      var FEED = "\f".charCodeAt(0);
      var TAB = "	".charCodeAt(0);
      var CR = "\r".charCodeAt(0);
      var OPEN_SQUARE = "[".charCodeAt(0);
      var CLOSE_SQUARE = "]".charCodeAt(0);
      var OPEN_PARENTHESES = "(".charCodeAt(0);
      var CLOSE_PARENTHESES = ")".charCodeAt(0);
      var OPEN_CURLY = "{".charCodeAt(0);
      var CLOSE_CURLY = "}".charCodeAt(0);
      var SEMICOLON = ";".charCodeAt(0);
      var ASTERISK = "*".charCodeAt(0);
      var COLON = ":".charCodeAt(0);
      var AT = "@".charCodeAt(0);
      var RE_AT_END = /[\t\n\f\r "#'()/;[\\\]{}]/g;
      var RE_WORD_END = /[\t\n\f\r !"#'():;@[\\\]{}]|\/(?=\*)/g;
      var RE_BAD_BRACKET = /.[\r\n"'(/\\]/;
      var RE_HEX_ESCAPE = /[\da-f]/i;
      module.exports = function tokenizer(input, options = {}) {
        let css = input.css.valueOf();
        let ignore = options.ignoreErrors;
        let code, content, escape, next, quote;
        let currentToken, escaped, escapePos, n2, prev;
        let length = css.length;
        let pos = 0;
        let buffer = [];
        let returned = [];
        let lastBadParen = -1;
        function position() {
          return pos;
        }
        function unclosed(what) {
          throw input.error("Unclosed " + what, pos);
        }
        function endOfFile() {
          return returned.length === 0 && pos >= length;
        }
        function nextToken(opts) {
          if (returned.length) return returned.pop();
          if (pos >= length) return;
          let ignoreUnclosed = opts ? opts.ignoreUnclosed : false;
          code = css.charCodeAt(pos);
          switch (code) {
            case NEWLINE:
            case SPACE:
            case TAB:
            case CR:
            case FEED: {
              next = pos;
              do {
                next += 1;
                code = css.charCodeAt(next);
              } while (code === SPACE || code === NEWLINE || code === TAB || code === CR || code === FEED);
              currentToken = ["space", css.slice(pos, next)];
              pos = next - 1;
              break;
            }
            case OPEN_SQUARE:
            case CLOSE_SQUARE:
            case OPEN_CURLY:
            case CLOSE_CURLY:
            case COLON:
            case SEMICOLON:
            case CLOSE_PARENTHESES: {
              let controlChar = String.fromCharCode(code);
              currentToken = [controlChar, controlChar, pos];
              break;
            }
            case OPEN_PARENTHESES: {
              prev = buffer.length ? buffer.pop()[1] : "";
              n2 = css.charCodeAt(pos + 1);
              if (prev === "url" && n2 !== SINGLE_QUOTE && n2 !== DOUBLE_QUOTE && n2 !== SPACE && n2 !== NEWLINE && n2 !== TAB && n2 !== FEED && n2 !== CR) {
                next = pos;
                do {
                  escaped = false;
                  next = css.indexOf(")", next + 1);
                  if (next === -1) {
                    if (ignore || ignoreUnclosed) {
                      next = pos;
                      break;
                    } else {
                      unclosed("bracket");
                    }
                  }
                  escapePos = next;
                  while (css.charCodeAt(escapePos - 1) === BACKSLASH) {
                    escapePos -= 1;
                    escaped = !escaped;
                  }
                } while (escaped);
                currentToken = ["brackets", css.slice(pos, next + 1), pos, next];
                pos = next;
              } else if (pos <= lastBadParen) {
                currentToken = ["(", "(", pos];
              } else {
                next = css.indexOf(")", pos + 1);
                content = css.slice(pos, next + 1);
                if (next === -1 || RE_BAD_BRACKET.test(content)) {
                  lastBadParen = next === -1 ? length : next;
                  currentToken = ["(", "(", pos];
                } else {
                  currentToken = ["brackets", content, pos, next];
                  pos = next;
                }
              }
              break;
            }
            case SINGLE_QUOTE:
            case DOUBLE_QUOTE: {
              quote = code === SINGLE_QUOTE ? "'" : '"';
              next = pos;
              do {
                escaped = false;
                next = css.indexOf(quote, next + 1);
                if (next === -1) {
                  if (ignore || ignoreUnclosed) {
                    next = pos + 1;
                    break;
                  } else {
                    unclosed("string");
                  }
                }
                escapePos = next;
                while (css.charCodeAt(escapePos - 1) === BACKSLASH) {
                  escapePos -= 1;
                  escaped = !escaped;
                }
              } while (escaped);
              currentToken = ["string", css.slice(pos, next + 1), pos, next];
              pos = next;
              break;
            }
            case AT: {
              RE_AT_END.lastIndex = pos + 1;
              RE_AT_END.test(css);
              if (RE_AT_END.lastIndex === 0) {
                next = css.length - 1;
              } else {
                next = RE_AT_END.lastIndex - 2;
              }
              currentToken = ["at-word", css.slice(pos, next + 1), pos, next];
              pos = next;
              break;
            }
            case BACKSLASH: {
              next = pos;
              escape = true;
              while (css.charCodeAt(next + 1) === BACKSLASH) {
                next += 1;
                escape = !escape;
              }
              code = css.charCodeAt(next + 1);
              if (escape && code !== SLASH && code !== SPACE && code !== NEWLINE && code !== TAB && code !== CR && code !== FEED) {
                next += 1;
                if (RE_HEX_ESCAPE.test(css.charAt(next))) {
                  while (RE_HEX_ESCAPE.test(css.charAt(next + 1))) {
                    next += 1;
                  }
                  if (css.charCodeAt(next + 1) === SPACE) {
                    next += 1;
                  }
                }
              }
              currentToken = ["word", css.slice(pos, next + 1), pos, next];
              pos = next;
              break;
            }
            default: {
              if (code === SLASH && css.charCodeAt(pos + 1) === ASTERISK) {
                next = css.indexOf("*/", pos + 2) + 1;
                if (next === 0) {
                  if (ignore || ignoreUnclosed) {
                    next = css.length;
                  } else {
                    unclosed("comment");
                  }
                }
                currentToken = ["comment", css.slice(pos, next + 1), pos, next];
                pos = next;
              } else {
                RE_WORD_END.lastIndex = pos + 1;
                RE_WORD_END.test(css);
                if (RE_WORD_END.lastIndex === 0) {
                  next = css.length - 1;
                } else {
                  next = RE_WORD_END.lastIndex - 2;
                }
                currentToken = ["word", css.slice(pos, next + 1), pos, next];
                buffer.push(currentToken);
                pos = next;
              }
              break;
            }
          }
          pos++;
          return currentToken;
        }
        function back(token) {
          returned.push(token);
        }
        return {
          back,
          endOfFile,
          nextToken,
          position
        };
      };
    }
  });

  // node_modules/postcss/lib/parser.js
  var require_parser = __commonJS({
    "node_modules/postcss/lib/parser.js"(exports, module) {
      "use strict";
      var AtRule2 = require_at_rule();
      var Comment2 = require_comment();
      var Declaration2 = require_declaration();
      var Root2 = require_root();
      var Rule2 = require_rule();
      var tokenizer = require_tokenize();
      var SAFE_COMMENT_NEIGHBOR = {
        empty: true,
        space: true
      };
      function findLastWithPosition(tokens) {
        for (let i2 = tokens.length - 1; i2 >= 0; i2--) {
          let token = tokens[i2];
          let pos = token[3] || token[2];
          if (pos) return pos;
        }
      }
      function tokensToString(tokens, from, to) {
        let result = "";
        for (let i2 = from; i2 < to; i2++) result += tokens[i2][1];
        return result;
      }
      var Parser = class {
        constructor(input) {
          this.input = input;
          this.root = new Root2();
          this.current = this.root;
          this.spaces = "";
          this.semicolon = false;
          this.createTokenizer();
          this.root.source = { input, start: { column: 1, line: 1, offset: 0 } };
        }
        atrule(token) {
          let node = new AtRule2();
          node.name = token[1].slice(1);
          if (node.name === "") {
            this.unnamedAtrule(node, token);
          }
          this.init(node, token[2]);
          let type;
          let prev;
          let shift;
          let last = false;
          let open = false;
          let params = [];
          let brackets = [];
          while (!this.tokenizer.endOfFile()) {
            token = this.tokenizer.nextToken();
            type = token[0];
            if (type === "(" || type === "[") {
              brackets.push(type === "(" ? ")" : "]");
            } else if (type === "{" && brackets.length > 0) {
              brackets.push("}");
            } else if (type === brackets[brackets.length - 1]) {
              brackets.pop();
            }
            if (brackets.length === 0) {
              if (type === ";") {
                node.source.end = this.getPosition(token[2]);
                node.source.end.offset++;
                this.semicolon = true;
                break;
              } else if (type === "{") {
                open = true;
                break;
              } else if (type === "}") {
                if (params.length > 0) {
                  shift = params.length - 1;
                  prev = params[shift];
                  while (prev && prev[0] === "space") {
                    prev = params[--shift];
                  }
                  if (prev) {
                    node.source.end = this.getPosition(prev[3] || prev[2]);
                    node.source.end.offset++;
                  }
                }
                this.end(token);
                break;
              } else {
                params.push(token);
              }
            } else {
              params.push(token);
            }
            if (this.tokenizer.endOfFile()) {
              last = true;
              break;
            }
          }
          node.raws.between = this.spacesAndCommentsFromEnd(params);
          if (params.length) {
            node.raws.afterName = this.spacesAndCommentsFromStart(params);
            this.raw(node, "params", params);
            if (last) {
              token = params[params.length - 1];
              node.source.end = this.getPosition(token[3] || token[2]);
              node.source.end.offset++;
              this.spaces = node.raws.between;
              node.raws.between = "";
            }
          } else {
            node.raws.afterName = "";
            node.params = "";
          }
          if (open) {
            node.nodes = [];
            this.current = node;
          }
        }
        checkMissedSemicolon(tokens) {
          let colon = this.colon(tokens);
          if (colon === false) return;
          let founded = 0;
          let token;
          for (let j2 = colon - 1; j2 >= 0; j2--) {
            token = tokens[j2];
            if (token[0] !== "space") {
              founded += 1;
              if (founded === 2) break;
            }
          }
          throw this.input.error(
            "Missed semicolon",
            token[0] === "word" ? token[3] + 1 : token[2]
          );
        }
        colon(tokens) {
          let brackets = 0;
          let prev, token, type;
          for (let [i2, element] of tokens.entries()) {
            token = element;
            type = token[0];
            if (type === "(") {
              brackets += 1;
            }
            if (type === ")") {
              brackets -= 1;
            }
            if (brackets === 0 && type === ":") {
              if (!prev) {
                this.doubleColon(token);
              } else if (prev[0] === "word" && prev[1] === "progid") {
                continue;
              } else {
                return i2;
              }
            }
            prev = token;
          }
          return false;
        }
        comment(token) {
          let node = new Comment2();
          this.init(node, token[2]);
          node.source.end = this.getPosition(token[3] || token[2]);
          node.source.end.offset++;
          let text = token[1].slice(2, -2);
          if (!text.trim()) {
            node.text = "";
            node.raws.left = text;
            node.raws.right = "";
          } else {
            let match = text.match(/^(\s*)([^]*\S)(\s*)$/);
            node.text = match[2];
            node.raws.left = match[1];
            node.raws.right = match[3];
          }
        }
        createTokenizer() {
          this.tokenizer = tokenizer(this.input);
        }
        decl(tokens, customProperty) {
          let node = new Declaration2();
          this.init(node, tokens[0][2]);
          let last = tokens[tokens.length - 1];
          if (last[0] === ";") {
            this.semicolon = true;
            tokens.pop();
          }
          node.source.end = this.getPosition(
            last[3] || last[2] || findLastWithPosition(tokens)
          );
          node.source.end.offset++;
          let start = 0;
          while (tokens[start][0] !== "word") {
            if (start === tokens.length - 1) this.unknownWord([tokens[start]]);
            start++;
          }
          node.raws.before += tokensToString(tokens, 0, start);
          node.source.start = this.getPosition(tokens[start][2]);
          let propStart = start;
          while (start < tokens.length) {
            let type = tokens[start][0];
            if (type === ":" || type === "space" || type === "comment") {
              break;
            }
            start++;
          }
          node.prop = tokensToString(tokens, propStart, start);
          let betweenStart = start;
          let token;
          while (start < tokens.length) {
            token = tokens[start];
            start++;
            if (token[0] === ":") break;
            if (token[0] === "word" && /\w/.test(token[1])) {
              this.unknownWord([token]);
            }
          }
          node.raws.between = tokensToString(tokens, betweenStart, start);
          if (node.prop[0] === "_" || node.prop[0] === "*") {
            node.raws.before += node.prop[0];
            node.prop = node.prop.slice(1);
          }
          let firstSpacesStart = start;
          while (start < tokens.length) {
            let next = tokens[start][0];
            if (next !== "space" && next !== "comment") break;
            start++;
          }
          let firstSpaces = tokens.slice(firstSpacesStart, start);
          tokens = tokens.slice(start);
          this.precheckMissedSemicolon(tokens);
          for (let i2 = tokens.length - 1; i2 >= 0; i2--) {
            token = tokens[i2];
            if (token[1].toLowerCase() === "!important") {
              node.important = true;
              let string = this.stringFrom(tokens, i2);
              string = this.spacesFromEnd(tokens) + string;
              if (string !== " !important") node.raws.important = string;
              break;
            } else if (token[1].toLowerCase() === "important") {
              let cache = tokens.slice(0);
              let str = "";
              for (let j2 = i2; j2 > 0; j2--) {
                let type = cache[j2][0];
                if (str.trim().startsWith("!") && type !== "space") {
                  break;
                }
                str = cache.pop()[1] + str;
              }
              if (str.trim().startsWith("!")) {
                node.important = true;
                node.raws.important = str;
                tokens = cache;
              }
            }
            if (token[0] !== "space" && token[0] !== "comment") {
              break;
            }
          }
          let hasWord = tokens.some((i2) => i2[0] !== "space" && i2[0] !== "comment");
          if (hasWord) {
            node.raws.between += firstSpaces.map((i2) => i2[1]).join("");
            firstSpaces = [];
          }
          this.raw(node, "value", firstSpaces.concat(tokens), customProperty);
          if (node.value.includes(":") && !customProperty) {
            this.checkMissedSemicolon(tokens);
          }
        }
        doubleColon(token) {
          throw this.input.error(
            "Double colon",
            { offset: token[2] },
            { offset: token[2] + token[1].length }
          );
        }
        emptyRule(token) {
          let node = new Rule2();
          this.init(node, token[2]);
          node.selector = "";
          node.raws.between = "";
          this.current = node;
        }
        end(token) {
          if (this.current.nodes && this.current.nodes.length) {
            this.current.raws.semicolon = this.semicolon;
          }
          this.semicolon = false;
          this.current.raws.after = (this.current.raws.after || "") + this.spaces;
          this.spaces = "";
          if (this.current.parent) {
            this.current.source.end = this.getPosition(token[2]);
            this.current.source.end.offset++;
            this.current = this.current.parent;
          } else {
            this.unexpectedClose(token);
          }
        }
        endFile() {
          if (this.current.parent) this.unclosedBlock();
          if (this.current.nodes && this.current.nodes.length) {
            this.current.raws.semicolon = this.semicolon;
          }
          this.current.raws.after = (this.current.raws.after || "") + this.spaces;
          this.root.source.end = this.getPosition(this.tokenizer.position());
        }
        freeSemicolon(token) {
          this.spaces += token[1];
          if (this.current.nodes) {
            let prev = this.current.nodes[this.current.nodes.length - 1];
            if (prev && prev.type === "rule" && !prev.raws.ownSemicolon) {
              prev.raws.ownSemicolon = this.spaces;
              this.spaces = "";
              prev.source.end = this.getPosition(token[2]);
              prev.source.end.offset += prev.raws.ownSemicolon.length;
            }
          }
        }
        // Helpers
        getPosition(offset) {
          let pos = this.input.fromOffset(offset);
          return {
            column: pos.col,
            line: pos.line,
            offset
          };
        }
        init(node, offset) {
          this.current.push(node);
          node.source = {
            input: this.input,
            start: this.getPosition(offset)
          };
          node.raws.before = this.spaces;
          this.spaces = "";
          if (node.type !== "comment") this.semicolon = false;
        }
        other(start) {
          let end = false;
          let type = null;
          let colon = false;
          let bracket = null;
          let brackets = [];
          let customProperty = start[1].startsWith("--");
          let tokens = [];
          let token = start;
          while (token) {
            type = token[0];
            tokens.push(token);
            if (type === "(" || type === "[") {
              if (!bracket) bracket = token;
              brackets.push(type === "(" ? ")" : "]");
            } else if (customProperty && colon && type === "{") {
              if (!bracket) bracket = token;
              brackets.push("}");
            } else if (brackets.length === 0) {
              if (type === ";") {
                if (colon) {
                  this.decl(tokens, customProperty);
                  return;
                } else {
                  break;
                }
              } else if (type === "{") {
                this.rule(tokens);
                return;
              } else if (type === "}") {
                this.tokenizer.back(tokens.pop());
                end = true;
                break;
              } else if (type === ":") {
                colon = true;
              }
            } else if (type === brackets[brackets.length - 1]) {
              brackets.pop();
              if (brackets.length === 0) bracket = null;
            }
            token = this.tokenizer.nextToken();
          }
          if (this.tokenizer.endOfFile()) end = true;
          if (brackets.length > 0) this.unclosedBracket(bracket);
          if (end && colon) {
            if (!customProperty) {
              while (tokens.length) {
                token = tokens[tokens.length - 1][0];
                if (token !== "space" && token !== "comment") break;
                this.tokenizer.back(tokens.pop());
              }
            }
            this.decl(tokens, customProperty);
          } else {
            this.unknownWord(tokens);
          }
        }
        parse() {
          let token;
          while (!this.tokenizer.endOfFile()) {
            token = this.tokenizer.nextToken();
            switch (token[0]) {
              case "space":
                this.spaces += token[1];
                break;
              case ";":
                this.freeSemicolon(token);
                break;
              case "}":
                this.end(token);
                break;
              case "comment":
                this.comment(token);
                break;
              case "at-word":
                this.atrule(token);
                break;
              case "{":
                this.emptyRule(token);
                break;
              default:
                this.other(token);
                break;
            }
          }
          this.endFile();
        }
        precheckMissedSemicolon() {
        }
        raw(node, prop, tokens, customProperty) {
          let token, type;
          let length = tokens.length;
          let value = "";
          let clean = true;
          let next, prev;
          for (let i2 = 0; i2 < length; i2 += 1) {
            token = tokens[i2];
            type = token[0];
            if (type === "space" && i2 === length - 1 && !customProperty) {
              clean = false;
            } else if (type === "comment") {
              prev = tokens[i2 - 1] ? tokens[i2 - 1][0] : "empty";
              next = tokens[i2 + 1] ? tokens[i2 + 1][0] : "empty";
              if (!SAFE_COMMENT_NEIGHBOR[prev] && !SAFE_COMMENT_NEIGHBOR[next]) {
                if (value.slice(-1) === ",") {
                  clean = false;
                } else {
                  value += token[1];
                }
              } else {
                clean = false;
              }
            } else {
              value += token[1];
            }
          }
          if (!clean) {
            let raw = tokens.reduce((all, i2) => all + i2[1], "");
            node.raws[prop] = { raw, value };
          }
          node[prop] = value;
        }
        rule(tokens) {
          tokens.pop();
          let node = new Rule2();
          this.init(node, tokens[0][2]);
          node.raws.between = this.spacesAndCommentsFromEnd(tokens);
          this.raw(node, "selector", tokens);
          this.current = node;
        }
        spacesAndCommentsFromEnd(tokens) {
          let lastTokenType;
          let spaces = "";
          while (tokens.length) {
            lastTokenType = tokens[tokens.length - 1][0];
            if (lastTokenType !== "space" && lastTokenType !== "comment") break;
            spaces = tokens.pop()[1] + spaces;
          }
          return spaces;
        }
        // Errors
        spacesAndCommentsFromStart(tokens) {
          let next;
          let spaces = "";
          while (tokens.length) {
            next = tokens[0][0];
            if (next !== "space" && next !== "comment") break;
            spaces += tokens.shift()[1];
          }
          return spaces;
        }
        spacesFromEnd(tokens) {
          let lastTokenType;
          let spaces = "";
          while (tokens.length) {
            lastTokenType = tokens[tokens.length - 1][0];
            if (lastTokenType !== "space") break;
            spaces = tokens.pop()[1] + spaces;
          }
          return spaces;
        }
        stringFrom(tokens, from) {
          let result = "";
          for (let i2 = from; i2 < tokens.length; i2++) {
            result += tokens[i2][1];
          }
          tokens.splice(from, tokens.length - from);
          return result;
        }
        unclosedBlock() {
          let pos = this.current.source.start;
          throw this.input.error("Unclosed block", pos.line, pos.column);
        }
        unclosedBracket(bracket) {
          throw this.input.error(
            "Unclosed bracket",
            { offset: bracket[2] },
            { offset: bracket[2] + 1 }
          );
        }
        unexpectedClose(token) {
          throw this.input.error(
            "Unexpected }",
            { offset: token[2] },
            { offset: token[2] + 1 }
          );
        }
        unknownWord(tokens) {
          throw this.input.error(
            "Unknown word " + tokens[0][1],
            { offset: tokens[0][2] },
            { offset: tokens[0][2] + tokens[0][1].length }
          );
        }
        unnamedAtrule(node, token) {
          throw this.input.error(
            "At-rule without name",
            { offset: token[2] },
            { offset: token[2] + token[1].length }
          );
        }
      };
      module.exports = Parser;
    }
  });

  // node_modules/postcss/lib/parse.js
  var require_parse = __commonJS({
    "node_modules/postcss/lib/parse.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var Input2 = require_input();
      var Parser = require_parser();
      function parse2(css, opts) {
        let input = new Input2(css, opts);
        let parser = new Parser(input);
        try {
          parser.parse();
        } catch (e4) {
          if (true) {
            if (e4.name === "CssSyntaxError" && opts && opts.from) {
              if (/\.scss$/i.test(opts.from)) {
                e4.message += "\nYou tried to parse SCSS with the standard CSS parser; try again with the postcss-scss parser";
              } else if (/\.sass/i.test(opts.from)) {
                e4.message += "\nYou tried to parse Sass with the standard CSS parser; try again with the postcss-sass parser";
              } else if (/\.less$/i.test(opts.from)) {
                e4.message += "\nYou tried to parse Less with the standard CSS parser; try again with the postcss-less parser";
              }
            }
          }
          throw e4;
        }
        return parser.root;
      }
      module.exports = parse2;
      parse2.default = parse2;
      Container2.registerParse(parse2);
    }
  });

  // node_modules/postcss/lib/warning.js
  var require_warning = __commonJS({
    "node_modules/postcss/lib/warning.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var { my } = require_symbols();
      var Warning2 = class {
        constructor(text, opts = {}) {
          this.type = "warning";
          this.text = text;
          if (opts.node && opts.node.source) {
            if (!opts.node[my]) {
              Container2.rebuild(opts.node);
            }
            let range = opts.node.rangeBy(opts);
            this.line = range.start.line;
            this.column = range.start.column;
            this.endLine = range.end.line;
            this.endColumn = range.end.column;
          }
          for (let opt in opts) this[opt] = opts[opt];
        }
        toString() {
          if (this.node) {
            return this.node.error(this.text, {
              index: this.index,
              plugin: this.plugin,
              word: this.word
            }).message;
          }
          if (this.plugin) {
            return this.plugin + ": " + this.text;
          }
          return this.text;
        }
      };
      module.exports = Warning2;
      Warning2.default = Warning2;
    }
  });

  // node_modules/postcss/lib/result.js
  var require_result = __commonJS({
    "node_modules/postcss/lib/result.js"(exports, module) {
      "use strict";
      var Warning2 = require_warning();
      var Result2 = class {
        get content() {
          return this.css;
        }
        constructor(processor, root2, opts) {
          this.processor = processor;
          this.messages = [];
          this.root = root2;
          this.opts = opts;
          this.css = "";
          this.map = void 0;
        }
        toString() {
          return this.css;
        }
        warn(text, opts = {}) {
          if (!opts.plugin) {
            if (this.lastPlugin && this.lastPlugin.postcssPlugin) {
              opts.plugin = this.lastPlugin.postcssPlugin;
            }
          }
          let warning = new Warning2(text, opts);
          this.messages.push(warning);
          return warning;
        }
        warnings() {
          return this.messages.filter((i2) => i2.type === "warning");
        }
      };
      module.exports = Result2;
      Result2.default = Result2;
    }
  });

  // node_modules/postcss/lib/warn-once.js
  var require_warn_once = __commonJS({
    "node_modules/postcss/lib/warn-once.js"(exports, module) {
      "use strict";
      var printed = {};
      module.exports = function warnOnce(message) {
        if (printed[message]) return;
        printed[message] = true;
        if (typeof console !== "undefined" && console.warn) {
          console.warn(message);
        }
      };
    }
  });

  // node_modules/postcss/lib/lazy-result.js
  var require_lazy_result = __commonJS({
    "node_modules/postcss/lib/lazy-result.js"(exports, module) {
      "use strict";
      var Container2 = require_container();
      var Document2 = require_document();
      var MapGenerator = require_map_generator();
      var parse2 = require_parse();
      var Result2 = require_result();
      var Root2 = require_root();
      var stringify2 = require_stringify();
      var { isClean, my } = require_symbols();
      var warnOnce = require_warn_once();
      var TYPE_TO_CLASS_NAME = {
        atrule: "AtRule",
        comment: "Comment",
        decl: "Declaration",
        document: "Document",
        root: "Root",
        rule: "Rule"
      };
      var PLUGIN_PROPS = {
        AtRule: true,
        AtRuleExit: true,
        Comment: true,
        CommentExit: true,
        Declaration: true,
        DeclarationExit: true,
        Document: true,
        DocumentExit: true,
        Once: true,
        OnceExit: true,
        postcssPlugin: true,
        prepare: true,
        Root: true,
        RootExit: true,
        Rule: true,
        RuleExit: true
      };
      var NOT_VISITORS = {
        Once: true,
        postcssPlugin: true,
        prepare: true
      };
      var CHILDREN = 0;
      function isPromise(obj) {
        return typeof obj === "object" && typeof obj.then === "function";
      }
      function getEvents(node) {
        let key = false;
        let type = TYPE_TO_CLASS_NAME[node.type];
        if (node.type === "decl") {
          key = node.prop.toLowerCase();
        } else if (node.type === "atrule") {
          key = node.name.toLowerCase();
        }
        if (key && node.append) {
          return [
            type,
            type + "-" + key,
            CHILDREN,
            type + "Exit",
            type + "Exit-" + key
          ];
        } else if (key) {
          return [type, type + "-" + key, type + "Exit", type + "Exit-" + key];
        } else if (node.append) {
          return [type, CHILDREN, type + "Exit"];
        } else {
          return [type, type + "Exit"];
        }
      }
      function toStack(node) {
        let events;
        if (node.type === "document") {
          events = ["Document", CHILDREN, "DocumentExit"];
        } else if (node.type === "root") {
          events = ["Root", CHILDREN, "RootExit"];
        } else {
          events = getEvents(node);
        }
        return {
          eventIndex: 0,
          events,
          iterator: 0,
          node,
          visitorIndex: 0,
          visitors: []
        };
      }
      function cleanMarks(node) {
        let stack = [node];
        while (stack.length > 0) {
          let next = stack.pop();
          next[isClean] = false;
          if (next.nodes) {
            for (let i2 of next.nodes) stack.push(i2);
          }
        }
        return node;
      }
      var postcss2 = {};
      var LazyResult = class _LazyResult {
        get content() {
          return this.stringify().content;
        }
        get css() {
          return this.stringify().css;
        }
        get map() {
          return this.stringify().map;
        }
        get messages() {
          return this.sync().messages;
        }
        get opts() {
          return this.result.opts;
        }
        get processor() {
          return this.result.processor;
        }
        get root() {
          return this.sync().root;
        }
        get [Symbol.toStringTag]() {
          return "LazyResult";
        }
        constructor(processor, css, opts) {
          this.stringified = false;
          this.processed = false;
          let root2;
          if (typeof css === "object" && css !== null && (css.type === "root" || css.type === "document")) {
            root2 = cleanMarks(css);
          } else if (css instanceof _LazyResult || css instanceof Result2) {
            root2 = cleanMarks(css.root);
            if (css.map) {
              if (typeof opts.map === "undefined") opts.map = {};
              if (!opts.map.inline) opts.map.inline = false;
              opts.map.prev = css.map;
            }
          } else {
            let parser = parse2;
            if (opts.syntax) parser = opts.syntax.parse;
            if (opts.parser) parser = opts.parser;
            if (parser.parse) parser = parser.parse;
            try {
              root2 = parser(css, opts);
            } catch (error) {
              this.processed = true;
              this.error = error;
            }
            if (root2 && !root2[my]) {
              Container2.rebuild(root2);
            }
          }
          this.result = new Result2(processor, root2, opts);
          this.helpers = { ...postcss2, postcss: postcss2, result: this.result };
          this.plugins = this.processor.plugins.map((plugin2) => {
            if (typeof plugin2 === "object" && plugin2.prepare) {
              return { ...plugin2, ...plugin2.prepare(this.result) };
            } else {
              return plugin2;
            }
          });
        }
        async() {
          if (this.error) return Promise.reject(this.error);
          if (this.processed) return Promise.resolve(this.result);
          if (!this.processing) {
            this.processing = this.runAsync();
          }
          return this.processing;
        }
        catch(onRejected) {
          return this.async().catch(onRejected);
        }
        finally(onFinally) {
          return this.async().then(onFinally, onFinally);
        }
        getAsyncError() {
          throw new Error("Use process(css).then(cb) to work with async plugins");
        }
        handleError(error, node) {
          let plugin2 = this.result.lastPlugin;
          try {
            if (node) node.addToError(error);
            this.error = error;
            if (error.name === "CssSyntaxError" && !error.plugin) {
              error.plugin = plugin2.postcssPlugin;
              error.setMessage();
            } else if (plugin2.postcssVersion) {
              if (true) {
                let pluginName = plugin2.postcssPlugin;
                let pluginVer = plugin2.postcssVersion;
                let runtimeVer = this.result.processor.version;
                let a2 = pluginVer.split(".");
                let b2 = runtimeVer.split(".");
                if (a2[0] !== b2[0] || parseInt(a2[1]) > parseInt(b2[1])) {
                  console.error(
                    "Unknown error from PostCSS plugin. Your current PostCSS version is " + runtimeVer + ", but " + pluginName + " uses " + pluginVer + ". Perhaps this is the source of the error below."
                  );
                }
              }
            }
          } catch (err) {
            if (console && console.error) console.error(err);
          }
          return error;
        }
        prepareVisitors() {
          this.listeners = {};
          let add = (plugin2, type, cb) => {
            if (!this.listeners[type]) this.listeners[type] = [];
            this.listeners[type].push([plugin2, cb]);
          };
          for (let plugin2 of this.plugins) {
            if (typeof plugin2 === "object") {
              for (let event in plugin2) {
                if (!PLUGIN_PROPS[event] && /^[A-Z]/.test(event)) {
                  throw new Error(
                    `Unknown event ${event} in ${plugin2.postcssPlugin}. Try to update PostCSS (${this.processor.version} now).`
                  );
                }
                if (!NOT_VISITORS[event]) {
                  if (typeof plugin2[event] === "object") {
                    for (let filter in plugin2[event]) {
                      if (filter === "*") {
                        add(plugin2, event, plugin2[event][filter]);
                      } else {
                        add(
                          plugin2,
                          event + "-" + filter.toLowerCase(),
                          plugin2[event][filter]
                        );
                      }
                    }
                  } else if (typeof plugin2[event] === "function") {
                    add(plugin2, event, plugin2[event]);
                  }
                }
              }
            }
          }
          this.hasListener = Object.keys(this.listeners).length > 0;
        }
        async runAsync() {
          this.plugin = 0;
          for (let i2 = 0; i2 < this.plugins.length; i2++) {
            let plugin2 = this.plugins[i2];
            let promise = this.runOnRoot(plugin2);
            if (isPromise(promise)) {
              try {
                await promise;
              } catch (error) {
                throw this.handleError(error);
              }
            }
          }
          this.prepareVisitors();
          if (this.hasListener) {
            let root2 = this.result.root;
            while (!root2[isClean]) {
              root2[isClean] = true;
              let stack = [toStack(root2)];
              while (stack.length > 0) {
                let promise = this.visitTick(stack);
                if (isPromise(promise)) {
                  try {
                    await promise;
                  } catch (e4) {
                    let node = stack[stack.length - 1].node;
                    throw this.handleError(e4, node);
                  }
                }
              }
            }
            if (this.listeners.OnceExit) {
              for (let [plugin2, visitor] of this.listeners.OnceExit) {
                this.result.lastPlugin = plugin2;
                try {
                  if (root2.type === "document") {
                    let roots = root2.nodes.map(
                      (subRoot) => visitor(subRoot, this.helpers)
                    );
                    await Promise.all(roots);
                  } else {
                    await visitor(root2, this.helpers);
                  }
                } catch (e4) {
                  throw this.handleError(e4);
                }
              }
            }
          }
          this.processed = true;
          return this.stringify();
        }
        runOnRoot(plugin2) {
          this.result.lastPlugin = plugin2;
          try {
            if (typeof plugin2 === "object" && plugin2.Once) {
              if (this.result.root.type === "document") {
                let roots = this.result.root.nodes.map(
                  (root2) => plugin2.Once(root2, this.helpers)
                );
                if (isPromise(roots[0])) {
                  return Promise.all(roots);
                }
                return roots;
              }
              return plugin2.Once(this.result.root, this.helpers);
            } else if (typeof plugin2 === "function") {
              return plugin2(this.result.root, this.result);
            }
          } catch (error) {
            throw this.handleError(error);
          }
        }
        stringify() {
          if (this.error) throw this.error;
          if (this.stringified) return this.result;
          this.stringified = true;
          this.sync();
          let opts = this.result.opts;
          let str = stringify2;
          if (opts.syntax) str = opts.syntax.stringify;
          if (opts.stringifier) str = opts.stringifier;
          if (str.stringify) str = str.stringify;
          let rootSource = this.result.root.source;
          if (opts.map === void 0 && !(rootSource && rootSource.input && rootSource.input.map)) {
            let result = "";
            str(this.result.root, (i2) => {
              result += i2;
            });
            this.result.css = result;
            return this.result;
          }
          let map = new MapGenerator(str, this.result.root, this.result.opts);
          let data = map.generate();
          this.result.css = data[0];
          this.result.map = data[1];
          return this.result;
        }
        sync() {
          if (this.error) throw this.error;
          if (this.processed) return this.result;
          this.processed = true;
          if (this.processing) {
            throw this.getAsyncError();
          }
          for (let plugin2 of this.plugins) {
            let promise = this.runOnRoot(plugin2);
            if (isPromise(promise)) {
              throw this.getAsyncError();
            }
          }
          this.prepareVisitors();
          if (this.hasListener) {
            let root2 = this.result.root;
            while (!root2[isClean]) {
              root2[isClean] = true;
              this.walkSync(root2);
            }
            if (this.listeners.OnceExit) {
              if (root2.type === "document") {
                for (let subRoot of root2.nodes) {
                  this.visitSync(this.listeners.OnceExit, subRoot);
                }
              } else {
                this.visitSync(this.listeners.OnceExit, root2);
              }
            }
          }
          return this.result;
        }
        then(onFulfilled, onRejected) {
          if (true) {
            if (!("from" in this.opts)) {
              warnOnce(
                "Without `from` option PostCSS could generate wrong source map and will not find Browserslist config. Set it to CSS file path or to `undefined` to prevent this warning."
              );
            }
          }
          return this.async().then(onFulfilled, onRejected);
        }
        toString() {
          return this.css;
        }
        visitSync(visitors, node) {
          for (let [plugin2, visitor] of visitors) {
            this.result.lastPlugin = plugin2;
            let promise;
            try {
              promise = visitor(node, this.helpers);
            } catch (e4) {
              throw this.handleError(e4, node.proxyOf);
            }
            if (node.type !== "root" && node.type !== "document" && !node.parent) {
              return true;
            }
            if (isPromise(promise)) {
              throw this.getAsyncError();
            }
          }
        }
        visitTick(stack) {
          let visit = stack[stack.length - 1];
          let { node, visitors } = visit;
          if (node.type !== "root" && node.type !== "document" && !node.parent) {
            stack.pop();
            return;
          }
          if (visitors.length > 0 && visit.visitorIndex < visitors.length) {
            let [plugin2, visitor] = visitors[visit.visitorIndex];
            visit.visitorIndex += 1;
            if (visit.visitorIndex === visitors.length) {
              visit.visitors = [];
              visit.visitorIndex = 0;
            }
            this.result.lastPlugin = plugin2;
            try {
              return visitor(node.toProxy(), this.helpers);
            } catch (e4) {
              throw this.handleError(e4, node);
            }
          }
          if (visit.iterator !== 0) {
            let iterator = visit.iterator;
            if (visit.descending) {
              visit.descending = false;
              node.indexes[iterator] += 1;
            }
            let child;
            while (child = node.nodes[node.indexes[iterator]]) {
              if (!child[isClean]) {
                child[isClean] = true;
                visit.descending = true;
                stack.push(toStack(child));
                return;
              }
              node.indexes[iterator] += 1;
            }
            visit.iterator = 0;
            delete node.indexes[iterator];
          }
          let events = visit.events;
          while (visit.eventIndex < events.length) {
            let event = events[visit.eventIndex];
            visit.eventIndex += 1;
            if (event === CHILDREN) {
              if (node.nodes && node.nodes.length) {
                node[isClean] = true;
                visit.iterator = node.getIterator();
              }
              return;
            } else if (this.listeners[event]) {
              visit.visitors = this.listeners[event];
              return;
            }
          }
          stack.pop();
        }
        walkSync(node) {
          node[isClean] = true;
          let stack = [{ eventIndex: 0, events: getEvents(node), iterator: 0, node }];
          while (stack.length > 0) {
            let visit = stack[stack.length - 1];
            let visitNode = visit.node;
            if (visit.iterator !== 0) {
              let iterator = visit.iterator;
              if (visit.descending) {
                visit.descending = false;
                visitNode.indexes[iterator] += 1;
              }
              let child;
              let descended = false;
              while (child = visitNode.nodes[visitNode.indexes[iterator]]) {
                if (!child[isClean]) {
                  child[isClean] = true;
                  visit.descending = true;
                  stack.push({
                    eventIndex: 0,
                    events: getEvents(child),
                    iterator: 0,
                    node: child
                  });
                  descended = true;
                  break;
                }
                visitNode.indexes[iterator] += 1;
              }
              if (descended) continue;
              visit.iterator = 0;
              delete visitNode.indexes[iterator];
            }
            if (visit.eventIndex < visit.events.length) {
              let event = visit.events[visit.eventIndex];
              visit.eventIndex += 1;
              if (event === CHILDREN) {
                if (visitNode.nodes && visitNode.nodes.length) {
                  visit.iterator = visitNode.getIterator();
                }
              } else {
                let visitors = this.listeners[event];
                if (visitors) {
                  if (this.visitSync(visitors, visitNode.toProxy())) stack.pop();
                }
              }
              continue;
            }
            stack.pop();
          }
        }
        warnings() {
          return this.sync().warnings();
        }
      };
      LazyResult.registerPostcss = (dependant) => {
        postcss2 = dependant;
      };
      module.exports = LazyResult;
      LazyResult.default = LazyResult;
      Root2.registerLazyResult(LazyResult);
      Document2.registerLazyResult(LazyResult);
    }
  });

  // node_modules/postcss/lib/no-work-result.js
  var require_no_work_result = __commonJS({
    "node_modules/postcss/lib/no-work-result.js"(exports, module) {
      "use strict";
      var MapGenerator = require_map_generator();
      var parse2 = require_parse();
      var Result2 = require_result();
      var stringify2 = require_stringify();
      var warnOnce = require_warn_once();
      var NoWorkResult = class {
        get content() {
          return this.result.css;
        }
        get css() {
          return this.result.css;
        }
        get map() {
          return this.result.map;
        }
        get messages() {
          return [];
        }
        get opts() {
          return this.result.opts;
        }
        get processor() {
          return this.result.processor;
        }
        get root() {
          if (this._root) {
            return this._root;
          }
          let root2;
          let parser = parse2;
          try {
            root2 = parser(this._css, this._opts);
          } catch (error) {
            this.error = error;
          }
          if (this.error) {
            throw this.error;
          } else {
            this._root = root2;
            return root2;
          }
        }
        get [Symbol.toStringTag]() {
          return "NoWorkResult";
        }
        constructor(processor, css, opts) {
          css = css.toString();
          this.stringified = false;
          this._processor = processor;
          this._css = css;
          this._opts = opts;
          this._map = void 0;
          let str = stringify2;
          this.result = new Result2(this._processor, void 0, this._opts);
          this.result.css = css;
          let self2 = this;
          Object.defineProperty(this.result, "root", {
            get() {
              return self2.root;
            }
          });
          let map = new MapGenerator(str, void 0, this._opts, css);
          if (map.isMap()) {
            let [generatedCSS, generatedMap] = map.generate();
            if (generatedCSS) {
              this.result.css = generatedCSS;
            }
            if (generatedMap) {
              this.result.map = generatedMap;
            }
          } else {
            map.clearAnnotation();
            this.result.css = map.css;
          }
        }
        async() {
          if (this.error) return Promise.reject(this.error);
          return Promise.resolve(this.result);
        }
        catch(onRejected) {
          return this.async().catch(onRejected);
        }
        finally(onFinally) {
          return this.async().then(onFinally, onFinally);
        }
        sync() {
          if (this.error) throw this.error;
          return this.result;
        }
        then(onFulfilled, onRejected) {
          if (true) {
            if (!("from" in this._opts)) {
              warnOnce(
                "Without `from` option PostCSS could generate wrong source map and will not find Browserslist config. Set it to CSS file path or to `undefined` to prevent this warning."
              );
            }
          }
          return this.async().then(onFulfilled, onRejected);
        }
        toString() {
          return this._css;
        }
        warnings() {
          return [];
        }
      };
      module.exports = NoWorkResult;
      NoWorkResult.default = NoWorkResult;
    }
  });

  // node_modules/postcss/lib/processor.js
  var require_processor = __commonJS({
    "node_modules/postcss/lib/processor.js"(exports, module) {
      "use strict";
      var Document2 = require_document();
      var LazyResult = require_lazy_result();
      var NoWorkResult = require_no_work_result();
      var Root2 = require_root();
      var Processor2 = class {
        constructor(plugins = []) {
          this.version = "8.5.25";
          this.plugins = this.normalize(plugins);
        }
        normalize(plugins) {
          let normalized = [];
          for (let i2 of plugins) {
            if (i2.postcss === true) {
              i2 = i2();
            } else if (i2.postcss) {
              i2 = i2.postcss;
            }
            if (typeof i2 === "object" && Array.isArray(i2.plugins)) {
              normalized = normalized.concat(i2.plugins);
            } else if (typeof i2 === "object" && i2.postcssPlugin) {
              normalized.push(i2);
            } else if (typeof i2 === "function") {
              normalized.push(i2);
            } else if (typeof i2 === "object" && (i2.parse || i2.stringify)) {
              if (true) {
                throw new Error(
                  "PostCSS syntaxes cannot be used as plugins. Instead, please use one of the syntax/parser/stringifier options as outlined in your PostCSS runner documentation."
                );
              }
            } else {
              throw new Error(i2 + " is not a PostCSS plugin");
            }
          }
          return normalized;
        }
        process(css, opts = {}) {
          if (!this.plugins.length && !opts.parser && !opts.stringifier && !opts.syntax) {
            return new NoWorkResult(this, css, opts);
          } else {
            return new LazyResult(this, css, opts);
          }
        }
        use(plugin2) {
          this.plugins = this.plugins.concat(this.normalize([plugin2]));
          return this;
        }
      };
      module.exports = Processor2;
      Processor2.default = Processor2;
      Root2.registerProcessor(Processor2);
      Document2.registerProcessor(Processor2);
    }
  });

  // node_modules/postcss/lib/postcss.js
  var require_postcss = __commonJS({
    "node_modules/postcss/lib/postcss.js"(exports, module) {
      "use strict";
      var AtRule2 = require_at_rule();
      var Comment2 = require_comment();
      var Container2 = require_container();
      var CssSyntaxError2 = require_css_syntax_error();
      var Declaration2 = require_declaration();
      var Document2 = require_document();
      var fromJSON2 = require_fromJSON();
      var Input2 = require_input();
      var LazyResult = require_lazy_result();
      var list2 = require_list();
      var Node3 = require_node();
      var parse2 = require_parse();
      var Processor2 = require_processor();
      var Result2 = require_result();
      var Root2 = require_root();
      var Rule2 = require_rule();
      var stringify2 = require_stringify();
      var Warning2 = require_warning();
      function postcss2(...plugins) {
        if (plugins.length === 1 && Array.isArray(plugins[0])) {
          plugins = plugins[0];
        }
        return new Processor2(plugins);
      }
      postcss2.plugin = function plugin2(name, initializer) {
        let warningPrinted = false;
        function creator2(...args) {
          if (console && console.warn && !warningPrinted) {
            warningPrinted = true;
            console.warn(
              name + ": postcss.plugin was deprecated. Migration guide:\nhttps://evilmartians.com/chronicles/postcss-8-plugin-migration"
            );
            if (process.env.LANG && process.env.LANG.startsWith("cn")) {
              console.warn(
                name + ": \u91CC\u9762 postcss.plugin \u88AB\u5F03\u7528. \u8FC1\u79FB\u6307\u5357:\nhttps://www.w3ctech.com/topic/2226"
              );
            }
          }
          let transformer = initializer(...args);
          transformer.postcssPlugin = name;
          transformer.postcssVersion = new Processor2().version;
          return transformer;
        }
        let cache;
        Object.defineProperty(creator2, "postcss", {
          get() {
            if (!cache) cache = creator2();
            return cache;
          }
        });
        creator2.process = function(css, processOpts, pluginOpts) {
          return postcss2([creator2(pluginOpts)]).process(css, processOpts);
        };
        return creator2;
      };
      postcss2.stringify = stringify2;
      postcss2.parse = parse2;
      postcss2.fromJSON = fromJSON2;
      postcss2.list = list2;
      postcss2.comment = (defaults) => new Comment2(defaults);
      postcss2.atRule = (defaults) => new AtRule2(defaults);
      postcss2.decl = (defaults) => new Declaration2(defaults);
      postcss2.rule = (defaults) => new Rule2(defaults);
      postcss2.root = (defaults) => new Root2(defaults);
      postcss2.document = (defaults) => new Document2(defaults);
      postcss2.CssSyntaxError = CssSyntaxError2;
      postcss2.Declaration = Declaration2;
      postcss2.Container = Container2;
      postcss2.Processor = Processor2;
      postcss2.Document = Document2;
      postcss2.Comment = Comment2;
      postcss2.Warning = Warning2;
      postcss2.AtRule = AtRule2;
      postcss2.Result = Result2;
      postcss2.Input = Input2;
      postcss2.Rule = Rule2;
      postcss2.Root = Root2;
      postcss2.Node = Node3;
      LazyResult.registerPostcss(postcss2);
      module.exports = postcss2;
      postcss2.default = postcss2;
    }
  });

  // node_modules/postcss-selector-parser/dist/util/unesc.js
  var require_unesc = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/unesc.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = unesc;
      function gobbleHex(str) {
        var lower = str.toLowerCase();
        var hex = "";
        var spaceTerminated = false;
        for (var i2 = 0; i2 < 6 && lower[i2] !== void 0; i2++) {
          var code = lower.charCodeAt(i2);
          var valid = code >= 97 && code <= 102 || code >= 48 && code <= 57;
          spaceTerminated = code === 32;
          if (!valid) {
            break;
          }
          hex += lower[i2];
        }
        if (hex.length === 0) {
          return void 0;
        }
        var codePoint = parseInt(hex, 16);
        var isSurrogate = codePoint >= 55296 && codePoint <= 57343;
        if (isSurrogate || codePoint === 0 || codePoint > 1114111) {
          return ["\uFFFD", hex.length + (spaceTerminated ? 1 : 0)];
        }
        return [String.fromCodePoint(codePoint), hex.length + (spaceTerminated ? 1 : 0)];
      }
      var CONTAINS_ESCAPE = /\\/;
      function unesc(str) {
        var needToProcess = CONTAINS_ESCAPE.test(str);
        if (!needToProcess) {
          return str;
        }
        var ret = "";
        for (var i2 = 0; i2 < str.length; i2++) {
          if (str[i2] === "\\") {
            var gobbled = gobbleHex(str.slice(i2 + 1, i2 + 7));
            if (gobbled !== void 0) {
              ret += gobbled[0];
              i2 += gobbled[1];
              continue;
            }
            if (str[i2 + 1] === "\\") {
              ret += "\\";
              i2++;
              continue;
            }
            if (str.length === i2 + 1) {
              ret += str[i2];
            }
            continue;
          }
          ret += str[i2];
        }
        return ret;
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/util/getProp.js
  var require_getProp = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/getProp.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = getProp;
      function getProp(obj) {
        var props = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          props[_i - 1] = arguments[_i];
        }
        while (props.length > 0) {
          var prop = props.shift();
          if (!obj[prop]) {
            return void 0;
          }
          obj = obj[prop];
        }
        return obj;
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/util/ensureObject.js
  var require_ensureObject = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/ensureObject.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = ensureObject;
      function ensureObject(obj) {
        var props = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          props[_i - 1] = arguments[_i];
        }
        while (props.length > 0) {
          var prop = props.shift();
          if (!obj[prop]) {
            obj[prop] = {};
          }
          obj = obj[prop];
        }
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/util/stripComments.js
  var require_stripComments = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/stripComments.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = stripComments;
      function stripComments(str) {
        var s2 = "";
        var commentStart = str.indexOf("/*");
        var lastEnd = 0;
        while (commentStart >= 0) {
          s2 = s2 + str.slice(lastEnd, commentStart);
          var commentEnd = str.indexOf("*/", commentStart + 2);
          if (commentEnd < 0) {
            return s2;
          }
          lastEnd = commentEnd + 2;
          commentStart = str.indexOf("/*", lastEnd);
        }
        s2 = s2 + str.slice(lastEnd);
        return s2;
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/util/maxNestingDepth.js
  var require_maxNestingDepth = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/maxNestingDepth.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.MAX_NESTING_DEPTH = void 0;
      exports.default = resolveMaxNestingDepth;
      exports.MAX_NESTING_DEPTH = 256;
      function resolveMaxNestingDepth(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : exports.MAX_NESTING_DEPTH;
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/util/index.js
  var require_util = __commonJS({
    "node_modules/postcss-selector-parser/dist/util/index.js"(exports) {
      "use strict";
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.MAX_NESTING_DEPTH = exports.resolveMaxNestingDepth = exports.stripComments = exports.ensureObject = exports.getProp = exports.unesc = void 0;
      var unesc_1 = require_unesc();
      Object.defineProperty(exports, "unesc", { enumerable: true, get: function() {
        return __importDefault(unesc_1).default;
      } });
      var getProp_1 = require_getProp();
      Object.defineProperty(exports, "getProp", { enumerable: true, get: function() {
        return __importDefault(getProp_1).default;
      } });
      var ensureObject_1 = require_ensureObject();
      Object.defineProperty(exports, "ensureObject", { enumerable: true, get: function() {
        return __importDefault(ensureObject_1).default;
      } });
      var stripComments_1 = require_stripComments();
      Object.defineProperty(exports, "stripComments", { enumerable: true, get: function() {
        return __importDefault(stripComments_1).default;
      } });
      var maxNestingDepth_1 = require_maxNestingDepth();
      Object.defineProperty(exports, "resolveMaxNestingDepth", { enumerable: true, get: function() {
        return __importDefault(maxNestingDepth_1).default;
      } });
      Object.defineProperty(exports, "MAX_NESTING_DEPTH", { enumerable: true, get: function() {
        return maxNestingDepth_1.MAX_NESTING_DEPTH;
      } });
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/node.js
  var require_node2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/node.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var util_1 = require_util();
      var cloneNode = function(obj, parent, depth) {
        if (depth === void 0) {
          depth = 0;
        }
        if (depth > util_1.MAX_NESTING_DEPTH) {
          throw new Error("Cannot clone selector: nesting depth exceeds the maximum of ".concat(util_1.MAX_NESTING_DEPTH, "."));
        }
        if (typeof obj !== "object" || obj === null) {
          return obj;
        }
        var cloned = new obj.constructor();
        for (var i2 in obj) {
          if (!obj.hasOwnProperty(i2)) {
            continue;
          }
          var value = obj[i2];
          var type = typeof value;
          if (i2 === "parent" && type === "object") {
            if (parent) {
              cloned[i2] = parent;
            }
          } else if (value instanceof Array) {
            cloned[i2] = value.map(function(j2) {
              return cloneNode(j2, cloned, depth + 1);
            });
          } else {
            cloned[i2] = cloneNode(value, cloned, depth + 1);
          }
        }
        return cloned;
      };
      var Node3 = (
        /** @class */
        (function() {
          function Node4(opts) {
            if (opts === void 0) {
              opts = {};
            }
            Object.assign(this, opts);
            this.spaces = this.spaces || {};
            this.spaces.before = this.spaces.before || "";
            this.spaces.after = this.spaces.after || "";
          }
          Node4.prototype.remove = function() {
            if (this.parent) {
              this.parent.removeChild(this);
            }
            this.parent = void 0;
            return this;
          };
          Node4.prototype.replaceWith = function() {
            if (this.parent) {
              for (var index in arguments) {
                this.parent.insertBefore(this, arguments[index]);
              }
              this.remove();
            }
            return this;
          };
          Node4.prototype.next = function() {
            return this.parent.at(this.parent.index(this) + 1);
          };
          Node4.prototype.prev = function() {
            return this.parent.at(this.parent.index(this) - 1);
          };
          Node4.prototype.clone = function(overrides) {
            if (overrides === void 0) {
              overrides = {};
            }
            var cloned = cloneNode(this);
            for (var name in overrides) {
              cloned[name] = overrides[name];
            }
            return cloned;
          };
          Node4.prototype.appendToPropertyAndEscape = function(name, value, valueEscaped) {
            if (!this.raws) {
              this.raws = {};
            }
            var originalValue = this[name];
            var originalEscaped = this.raws[name];
            this[name] = originalValue + value;
            if (originalEscaped || valueEscaped !== value) {
              this.raws[name] = (originalEscaped || originalValue) + valueEscaped;
            } else {
              delete this.raws[name];
            }
          };
          Node4.prototype.setPropertyAndEscape = function(name, value, valueEscaped) {
            if (!this.raws) {
              this.raws = {};
            }
            this[name] = value;
            this.raws[name] = valueEscaped;
          };
          Node4.prototype.setPropertyWithoutEscape = function(name, value) {
            this[name] = value;
            if (this.raws) {
              delete this.raws[name];
            }
          };
          Node4.prototype.isAtPosition = function(line, column) {
            if (this.source && this.source.start && this.source.end) {
              if (this.source.start.line > line) {
                return false;
              }
              if (this.source.end.line < line) {
                return false;
              }
              if (this.source.start.line === line && this.source.start.column > column) {
                return false;
              }
              if (this.source.end.line === line && this.source.end.column < column) {
                return false;
              }
              return true;
            }
            return void 0;
          };
          Node4.prototype.stringifyProperty = function(name) {
            return this.raws && this.raws[name] || this[name];
          };
          Object.defineProperty(Node4.prototype, "rawSpaceBefore", {
            get: function() {
              var rawSpace = this.raws && this.raws.spaces && this.raws.spaces.before;
              if (rawSpace === void 0) {
                rawSpace = this.spaces && this.spaces.before;
              }
              return rawSpace || "";
            },
            set: function(raw) {
              (0, util_1.ensureObject)(this, "raws", "spaces");
              this.raws.spaces.before = raw;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Node4.prototype, "rawSpaceAfter", {
            get: function() {
              var rawSpace = this.raws && this.raws.spaces && this.raws.spaces.after;
              if (rawSpace === void 0) {
                rawSpace = this.spaces.after;
              }
              return rawSpace || "";
            },
            set: function(raw) {
              (0, util_1.ensureObject)(this, "raws", "spaces");
              this.raws.spaces.after = raw;
            },
            enumerable: false,
            configurable: true
          });
          Node4.prototype.valueToString = function() {
            return String(this.stringifyProperty("value"));
          };
          Node4.prototype.toString = function() {
            return [this.rawSpaceBefore, this.valueToString(), this.rawSpaceAfter].join("");
          };
          Node4.prototype._stringify = function() {
            return this.toString();
          };
          return Node4;
        })()
      );
      exports.default = Node3;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/types.js
  var require_types = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/types.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.UNIVERSAL = exports.ATTRIBUTE = exports.CLASS = exports.COMBINATOR = exports.COMMENT = exports.ID = exports.NESTING = exports.PSEUDO = exports.ROOT = exports.SELECTOR = exports.STRING = exports.TAG = void 0;
      exports.TAG = "tag";
      exports.STRING = "string";
      exports.SELECTOR = "selector";
      exports.ROOT = "root";
      exports.PSEUDO = "pseudo";
      exports.NESTING = "nesting";
      exports.ID = "id";
      exports.COMMENT = "comment";
      exports.COMBINATOR = "combinator";
      exports.CLASS = "class";
      exports.ATTRIBUTE = "attribute";
      exports.UNIVERSAL = "universal";
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/container.js
  var require_container2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/container.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        var desc = Object.getOwnPropertyDescriptor(m2, k2);
        if (!desc || ("get" in desc ? !m2.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m2[k2];
          } };
        }
        Object.defineProperty(o2, k22, desc);
      }) : (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        o2[k22] = m2[k2];
      }));
      var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o2, v2) {
        Object.defineProperty(o2, "default", { enumerable: true, value: v2 });
      }) : function(o2, v2) {
        o2["default"] = v2;
      });
      var __importStar = exports && exports.__importStar || /* @__PURE__ */ (function() {
        var ownKeys = function(o2) {
          ownKeys = Object.getOwnPropertyNames || function(o3) {
            var ar = [];
            for (var k2 in o3) if (Object.prototype.hasOwnProperty.call(o3, k2)) ar[ar.length] = k2;
            return ar;
          };
          return ownKeys(o2);
        };
        return function(mod) {
          if (mod && mod.__esModule) return mod;
          var result = {};
          if (mod != null) {
            for (var k2 = ownKeys(mod), i2 = 0; i2 < k2.length; i2++) if (k2[i2] !== "default") __createBinding(result, mod, k2[i2]);
          }
          __setModuleDefault(result, mod);
          return result;
        };
      })();
      var __values = exports && exports.__values || function(o2) {
        var s2 = typeof Symbol === "function" && Symbol.iterator, m2 = s2 && o2[s2], i2 = 0;
        if (m2) return m2.call(o2);
        if (o2 && typeof o2.length === "number") return {
          next: function() {
            if (o2 && i2 >= o2.length) o2 = void 0;
            return { value: o2 && o2[i2++], done: !o2 };
          }
        };
        throw new TypeError(s2 ? "Object is not iterable." : "Symbol.iterator is not defined.");
      };
      var __read = exports && exports.__read || function(o2, n2) {
        var m2 = typeof Symbol === "function" && o2[Symbol.iterator];
        if (!m2) return o2;
        var i2 = m2.call(o2), r2, ar = [], e4;
        try {
          while ((n2 === void 0 || n2-- > 0) && !(r2 = i2.next()).done) ar.push(r2.value);
        } catch (error) {
          e4 = { error };
        } finally {
          try {
            if (r2 && !r2.done && (m2 = i2["return"])) m2.call(i2);
          } finally {
            if (e4) throw e4.error;
          }
        }
        return ar;
      };
      var __spreadArray = exports && exports.__spreadArray || function(to, from, pack) {
        if (pack || arguments.length === 2) for (var i2 = 0, l2 = from.length, ar; i2 < l2; i2++) {
          if (ar || !(i2 in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i2);
            ar[i2] = from[i2];
          }
        }
        return to.concat(ar || Array.prototype.slice.call(from));
      };
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var util_1 = require_util();
      var node_1 = __importDefault(require_node2());
      var types = __importStar(require_types());
      var Container2 = (
        /** @class */
        (function(_super) {
          __extends(Container3, _super);
          function Container3(opts) {
            var _this = _super.call(this, opts) || this;
            if (!_this.nodes) {
              _this.nodes = [];
            }
            return _this;
          }
          Container3.prototype.append = function(selector) {
            selector.parent = this;
            this.nodes.push(selector);
            return this;
          };
          Container3.prototype.prepend = function(selector) {
            selector.parent = this;
            this.nodes.unshift(selector);
            for (var id in this.indexes) {
              this.indexes[id]++;
            }
            return this;
          };
          Container3.prototype.at = function(index) {
            return this.nodes[index];
          };
          Container3.prototype.index = function(child) {
            if (typeof child === "number") {
              return child;
            }
            return this.nodes.indexOf(child);
          };
          Object.defineProperty(Container3.prototype, "first", {
            get: function() {
              return this.at(0);
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Container3.prototype, "last", {
            get: function() {
              return this.at(this.length - 1);
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Container3.prototype, "length", {
            get: function() {
              return this.nodes.length;
            },
            enumerable: false,
            configurable: true
          });
          Container3.prototype.removeChild = function(child) {
            child = this.index(child);
            this.at(child).parent = void 0;
            this.nodes.splice(child, 1);
            var index;
            for (var id in this.indexes) {
              index = this.indexes[id];
              if (index >= child) {
                this.indexes[id] = index - 1;
              }
            }
            return this;
          };
          Container3.prototype.removeAll = function() {
            var e_1, _a;
            try {
              for (var _b = __values(this.nodes), _c = _b.next(); !_c.done; _c = _b.next()) {
                var node = _c.value;
                node.parent = void 0;
              }
            } catch (e_1_1) {
              e_1 = { error: e_1_1 };
            } finally {
              try {
                if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
              } finally {
                if (e_1) throw e_1.error;
              }
            }
            this.nodes = [];
            return this;
          };
          Container3.prototype.empty = function() {
            return this.removeAll();
          };
          Container3.prototype.insertAfter = function(oldNode, newNode) {
            var _a;
            newNode.parent = this;
            var oldIndex = this.index(oldNode);
            var resetNode = [];
            for (var i2 = 2; i2 < arguments.length; i2++) {
              resetNode.push(arguments[i2]);
            }
            (_a = this.nodes).splice.apply(_a, __spreadArray([oldIndex + 1, 0, newNode], __read(resetNode), false));
            newNode.parent = this;
            var index;
            for (var id in this.indexes) {
              index = this.indexes[id];
              if (oldIndex < index) {
                this.indexes[id] = index + arguments.length - 1;
              }
            }
            return this;
          };
          Container3.prototype.insertBefore = function(oldNode, newNode) {
            var _a;
            newNode.parent = this;
            var oldIndex = this.index(oldNode);
            var resetNode = [];
            for (var i2 = 2; i2 < arguments.length; i2++) {
              resetNode.push(arguments[i2]);
            }
            (_a = this.nodes).splice.apply(_a, __spreadArray([oldIndex, 0, newNode], __read(resetNode), false));
            newNode.parent = this;
            var index;
            for (var id in this.indexes) {
              index = this.indexes[id];
              if (index >= oldIndex) {
                this.indexes[id] = index + arguments.length - 1;
              }
            }
            return this;
          };
          Container3.prototype._findChildAtPosition = function(line, col) {
            var found = void 0;
            this.each(function(node) {
              if (node.atPosition) {
                var foundChild = node.atPosition(line, col);
                if (foundChild) {
                  found = foundChild;
                  return false;
                }
              } else if (node.isAtPosition(line, col)) {
                found = node;
                return false;
              }
            });
            return found;
          };
          Container3.prototype.atPosition = function(line, col) {
            if (this.isAtPosition(line, col)) {
              return this._findChildAtPosition(line, col) || this;
            } else {
              return void 0;
            }
          };
          Container3.prototype._inferEndPosition = function() {
            if (this.last && this.last.source && this.last.source.end) {
              this.source = this.source || {};
              this.source.end = this.source.end || {};
              Object.assign(this.source.end, this.last.source.end);
            }
          };
          Container3.prototype.each = function(callback) {
            if (!this.lastEach) {
              this.lastEach = 0;
            }
            if (!this.indexes) {
              this.indexes = {};
            }
            this.lastEach++;
            var id = this.lastEach;
            this.indexes[id] = 0;
            if (!this.length) {
              return void 0;
            }
            var index, result;
            while (this.indexes[id] < this.length) {
              index = this.indexes[id];
              result = callback(this.at(index), index);
              if (result === false) {
                break;
              }
              this.indexes[id] += 1;
            }
            delete this.indexes[id];
            if (result === false) {
              return false;
            }
          };
          Container3.prototype.walk = function(callback, depth) {
            if (depth === void 0) {
              depth = 0;
            }
            if (depth > util_1.MAX_NESTING_DEPTH) {
              throw new Error("Cannot walk selector: nesting depth exceeds the maximum of ".concat(util_1.MAX_NESTING_DEPTH, "."));
            }
            return this.each(function(node, i2) {
              var result = callback(node, i2);
              if (result !== false && node.length) {
                result = node.walk(callback, depth + 1);
              }
              if (result === false) {
                return false;
              }
            });
          };
          Container3.prototype.walkAttributes = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.ATTRIBUTE) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkClasses = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.CLASS) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkCombinators = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.COMBINATOR) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkComments = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.COMMENT) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkIds = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.ID) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkNesting = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.NESTING) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkPseudos = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.PSEUDO) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkTags = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.TAG) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.walkUniversals = function(callback) {
            var _this = this;
            return this.walk(function(selector) {
              if (selector.type === types.UNIVERSAL) {
                return callback.call(_this, selector);
              }
            });
          };
          Container3.prototype.split = function(callback) {
            var _this = this;
            var current = [];
            return this.reduce(function(memo, node, index) {
              var split = callback.call(_this, node);
              current.push(node);
              if (split) {
                memo.push(current);
                current = [];
              } else if (index === _this.length - 1) {
                memo.push(current);
              }
              return memo;
            }, []);
          };
          Container3.prototype.map = function(callback) {
            return this.nodes.map(callback);
          };
          Container3.prototype.reduce = function(callback, memo) {
            return this.nodes.reduce(callback, memo);
          };
          Container3.prototype.every = function(callback) {
            return this.nodes.every(callback);
          };
          Container3.prototype.some = function(callback) {
            return this.nodes.some(callback);
          };
          Container3.prototype.filter = function(callback) {
            return this.nodes.filter(callback);
          };
          Container3.prototype.sort = function(callback) {
            return this.nodes.sort(callback);
          };
          Container3.prototype.toString = function(options) {
            if (options === void 0) {
              options = {};
            }
            return this._stringify(options, 0, (0, util_1.resolveMaxNestingDepth)(options.maxNestingDepth));
          };
          Container3.prototype._stringify = function(options, depth, max) {
            var _this = this;
            return this.map(function(child) {
              return _this._stringifyChild(child, options, depth, max);
            }).join("");
          };
          Container3.prototype._stringifyChild = function(child, options, depth, max) {
            return typeof child._stringify === "function" ? child._stringify(options, depth, max) : String(child);
          };
          return Container3;
        })(node_1.default)
      );
      exports.default = Container2;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/root.js
  var require_root2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/root.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var container_1 = __importDefault(require_container2());
      var types_1 = require_types();
      var Root2 = (
        /** @class */
        (function(_super) {
          __extends(Root3, _super);
          function Root3(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.ROOT;
            return _this;
          }
          Root3.prototype._stringify = function(options, depth, max) {
            var _this = this;
            var str = this.reduce(function(memo, selector) {
              memo.push(_this._stringifyChild(selector, options, depth, max));
              return memo;
            }, []).join(",");
            return this.trailingComma ? str + "," : str;
          };
          Root3.prototype.error = function(message, options) {
            if (this._error) {
              return this._error(message, options);
            } else {
              return new Error(message);
            }
          };
          Object.defineProperty(Root3.prototype, "errorGenerator", {
            set: function(handler) {
              this._error = handler;
            },
            enumerable: false,
            configurable: true
          });
          return Root3;
        })(container_1.default)
      );
      exports.default = Root2;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/selector.js
  var require_selector = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/selector.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var container_1 = __importDefault(require_container2());
      var types_1 = require_types();
      var Selector = (
        /** @class */
        (function(_super) {
          __extends(Selector2, _super);
          function Selector2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.SELECTOR;
            return _this;
          }
          return Selector2;
        })(container_1.default)
      );
      exports.default = Selector;
    }
  });

  // node_modules/cssesc/cssesc.js
  var require_cssesc = __commonJS({
    "node_modules/cssesc/cssesc.js"(exports, module) {
      "use strict";
      var object = {};
      var hasOwnProperty = object.hasOwnProperty;
      var merge = function merge2(options, defaults) {
        if (!options) {
          return defaults;
        }
        var result = {};
        for (var key in defaults) {
          result[key] = hasOwnProperty.call(options, key) ? options[key] : defaults[key];
        }
        return result;
      };
      var regexAnySingleEscape = /[ -,\.\/:-@\[-\^`\{-~]/;
      var regexSingleEscape = /[ -,\.\/:-@\[\]\^`\{-~]/;
      var regexExcessiveSpaces = /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g;
      var cssesc = function cssesc2(string, options) {
        options = merge(options, cssesc2.options);
        if (options.quotes != "single" && options.quotes != "double") {
          options.quotes = "single";
        }
        var quote = options.quotes == "double" ? '"' : "'";
        var isIdentifier = options.isIdentifier;
        var firstChar = string.charAt(0);
        var output = "";
        var counter = 0;
        var length = string.length;
        while (counter < length) {
          var character = string.charAt(counter++);
          var codePoint = character.charCodeAt();
          var value = void 0;
          if (codePoint < 32 || codePoint > 126) {
            if (codePoint >= 55296 && codePoint <= 56319 && counter < length) {
              var extra = string.charCodeAt(counter++);
              if ((extra & 64512) == 56320) {
                codePoint = ((codePoint & 1023) << 10) + (extra & 1023) + 65536;
              } else {
                counter--;
              }
            }
            value = "\\" + codePoint.toString(16).toUpperCase() + " ";
          } else {
            if (options.escapeEverything) {
              if (regexAnySingleEscape.test(character)) {
                value = "\\" + character;
              } else {
                value = "\\" + codePoint.toString(16).toUpperCase() + " ";
              }
            } else if (/[\t\n\f\r\x0B]/.test(character)) {
              value = "\\" + codePoint.toString(16).toUpperCase() + " ";
            } else if (character == "\\" || !isIdentifier && (character == '"' && quote == character || character == "'" && quote == character) || isIdentifier && regexSingleEscape.test(character)) {
              value = "\\" + character;
            } else {
              value = character;
            }
          }
          output += value;
        }
        if (isIdentifier) {
          if (/^-[-\d]/.test(output)) {
            output = "\\-" + output.slice(1);
          } else if (/\d/.test(firstChar)) {
            output = "\\3" + firstChar + " " + output.slice(1);
          }
        }
        output = output.replace(regexExcessiveSpaces, function($0, $1, $2) {
          if ($1 && $1.length % 2) {
            return $0;
          }
          return ($1 || "") + $2;
        });
        if (!isIdentifier && options.wrap) {
          return quote + output + quote;
        }
        return output;
      };
      cssesc.options = {
        "escapeEverything": false,
        "isIdentifier": false,
        "quotes": "single",
        "wrap": false
      };
      cssesc.version = "3.0.0";
      module.exports = cssesc;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/className.js
  var require_className = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/className.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var cssesc_1 = __importDefault(require_cssesc());
      var util_1 = require_util();
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var ClassName = (
        /** @class */
        (function(_super) {
          __extends(ClassName2, _super);
          function ClassName2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.CLASS;
            _this._constructed = true;
            return _this;
          }
          Object.defineProperty(ClassName2.prototype, "value", {
            get: function() {
              return this._value;
            },
            set: function(v2) {
              if (this._constructed) {
                var escaped = (0, cssesc_1.default)(v2, { isIdentifier: true });
                if (escaped !== v2) {
                  (0, util_1.ensureObject)(this, "raws");
                  this.raws.value = escaped;
                } else if (this.raws) {
                  delete this.raws.value;
                }
              }
              this._value = v2;
            },
            enumerable: false,
            configurable: true
          });
          ClassName2.prototype.valueToString = function() {
            return "." + _super.prototype.valueToString.call(this);
          };
          return ClassName2;
        })(node_1.default)
      );
      exports.default = ClassName;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/comment.js
  var require_comment2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/comment.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var Comment2 = (
        /** @class */
        (function(_super) {
          __extends(Comment3, _super);
          function Comment3(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.COMMENT;
            return _this;
          }
          return Comment3;
        })(node_1.default)
      );
      exports.default = Comment2;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/id.js
  var require_id = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/id.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var ID = (
        /** @class */
        (function(_super) {
          __extends(ID2, _super);
          function ID2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.ID;
            return _this;
          }
          ID2.prototype.valueToString = function() {
            return "#" + _super.prototype.valueToString.call(this);
          };
          return ID2;
        })(node_1.default)
      );
      exports.default = ID;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/namespace.js
  var require_namespace = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/namespace.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var cssesc_1 = __importDefault(require_cssesc());
      var util_1 = require_util();
      var node_1 = __importDefault(require_node2());
      var Namespace = (
        /** @class */
        (function(_super) {
          __extends(Namespace2, _super);
          function Namespace2() {
            return _super !== null && _super.apply(this, arguments) || this;
          }
          Object.defineProperty(Namespace2.prototype, "namespace", {
            get: function() {
              return this._namespace;
            },
            set: function(namespace) {
              if (namespace === true || namespace === "*" || namespace === "&") {
                this._namespace = namespace;
                if (this.raws) {
                  delete this.raws.namespace;
                }
                return;
              }
              var escaped = (0, cssesc_1.default)(namespace, { isIdentifier: true });
              this._namespace = namespace;
              if (escaped !== namespace) {
                (0, util_1.ensureObject)(this, "raws");
                this.raws.namespace = escaped;
              } else if (this.raws) {
                delete this.raws.namespace;
              }
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Namespace2.prototype, "ns", {
            get: function() {
              return this._namespace;
            },
            set: function(namespace) {
              this.namespace = namespace;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Namespace2.prototype, "namespaceString", {
            get: function() {
              if (this.namespace) {
                var ns = this.stringifyProperty("namespace");
                if (ns === true) {
                  return "";
                } else {
                  return ns;
                }
              } else {
                return "";
              }
            },
            enumerable: false,
            configurable: true
          });
          Namespace2.prototype.qualifiedName = function(value) {
            if (this.namespace) {
              return "".concat(this.namespaceString, "|").concat(value);
            } else {
              return value;
            }
          };
          Namespace2.prototype.valueToString = function() {
            return this.qualifiedName(_super.prototype.valueToString.call(this));
          };
          return Namespace2;
        })(node_1.default)
      );
      exports.default = Namespace;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/tag.js
  var require_tag = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/tag.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var namespace_1 = __importDefault(require_namespace());
      var types_1 = require_types();
      var Tag = (
        /** @class */
        (function(_super) {
          __extends(Tag2, _super);
          function Tag2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.TAG;
            return _this;
          }
          return Tag2;
        })(namespace_1.default)
      );
      exports.default = Tag;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/string.js
  var require_string = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/string.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String2(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var String2 = (
        /** @class */
        (function(_super) {
          __extends(String3, _super);
          function String3(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.STRING;
            return _this;
          }
          return String3;
        })(node_1.default)
      );
      exports.default = String2;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/pseudo.js
  var require_pseudo = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/pseudo.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var container_1 = __importDefault(require_container2());
      var types_1 = require_types();
      var Pseudo = (
        /** @class */
        (function(_super) {
          __extends(Pseudo2, _super);
          function Pseudo2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.PSEUDO;
            return _this;
          }
          Pseudo2.prototype._stringify = function(options, depth, max) {
            var _this = this;
            if (depth >= max) {
              throw new Error("Cannot serialize selector: nesting depth exceeds the maximum of ".concat(max, "."));
            }
            var params = this.length ? "(" + this.map(function(child) {
              return _this._stringifyChild(child, options, depth + 1, max);
            }).join(",") + ")" : "";
            return [this.rawSpaceBefore, this.stringifyProperty("value"), params, this.rawSpaceAfter].join("");
          };
          return Pseudo2;
        })(container_1.default)
      );
      exports.default = Pseudo;
    }
  });

  // node_modules/util-deprecate/browser.js
  var require_browser = __commonJS({
    "node_modules/util-deprecate/browser.js"(exports, module) {
      module.exports = deprecate;
      function deprecate(fn, msg) {
        if (config("noDeprecation")) {
          return fn;
        }
        var warned = false;
        function deprecated() {
          if (!warned) {
            if (config("throwDeprecation")) {
              throw new Error(msg);
            } else if (config("traceDeprecation")) {
              console.trace(msg);
            } else {
              console.warn(msg);
            }
            warned = true;
          }
          return fn.apply(this, arguments);
        }
        return deprecated;
      }
      function config(name) {
        try {
          if (!global.localStorage) return false;
        } catch (_2) {
          return false;
        }
        var val = global.localStorage[name];
        if (null == val) return false;
        return String(val).toLowerCase() === "true";
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/attribute.js
  var require_attribute = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/attribute.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      var _a;
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.unescapeValue = unescapeValue;
      var cssesc_1 = __importDefault(require_cssesc());
      var unesc_1 = __importDefault(require_unesc());
      var namespace_1 = __importDefault(require_namespace());
      var types_1 = require_types();
      var deprecate = require_browser();
      var WRAPPED_IN_QUOTES = /^('|")([^]*)\1$/;
      var warnOfDeprecatedValueAssignment = deprecate(function() {
      }, "Assigning an attribute a value containing characters that might need to be escaped is deprecated. Call attribute.setValue() instead.");
      var warnOfDeprecatedQuotedAssignment = deprecate(function() {
      }, "Assigning attr.quoted is deprecated and has no effect. Assign to attr.quoteMark instead.");
      var warnOfDeprecatedConstructor = deprecate(function() {
      }, "Constructing an Attribute selector with a value without specifying quoteMark is deprecated. Note: The value should be unescaped now.");
      function unescapeValue(value) {
        var deprecatedUsage = false;
        var quoteMark = null;
        var unescaped = value;
        var m2 = unescaped.match(WRAPPED_IN_QUOTES);
        if (m2) {
          quoteMark = m2[1];
          unescaped = m2[2];
        }
        unescaped = (0, unesc_1.default)(unescaped);
        if (unescaped !== value) {
          deprecatedUsage = true;
        }
        return {
          deprecatedUsage,
          unescaped,
          quoteMark
        };
      }
      function handleDeprecatedContructorOpts(opts) {
        if (opts.quoteMark !== void 0) {
          return opts;
        }
        if (opts.value === void 0) {
          return opts;
        }
        warnOfDeprecatedConstructor();
        var _a2 = unescapeValue(opts.value), quoteMark = _a2.quoteMark, unescaped = _a2.unescaped;
        if (!opts.raws) {
          opts.raws = {};
        }
        if (opts.raws.value === void 0) {
          opts.raws.value = opts.value;
        }
        opts.value = unescaped;
        opts.quoteMark = quoteMark;
        return opts;
      }
      var Attribute = (
        /** @class */
        (function(_super) {
          __extends(Attribute2, _super);
          function Attribute2(opts) {
            if (opts === void 0) {
              opts = {};
            }
            var _this = _super.call(this, handleDeprecatedContructorOpts(opts)) || this;
            _this.type = types_1.ATTRIBUTE;
            _this.raws = _this.raws || {};
            Object.defineProperty(_this.raws, "unquoted", {
              get: deprecate(function() {
                return _this.value;
              }, "attr.raws.unquoted is deprecated. Call attr.value instead."),
              set: deprecate(function() {
                return _this.value;
              }, "Setting attr.raws.unquoted is deprecated and has no effect. attr.value is unescaped by default now.")
            });
            _this._constructed = true;
            return _this;
          }
          Attribute2.prototype.getQuotedValue = function(options) {
            if (options === void 0) {
              options = {};
            }
            var quoteMark = this._determineQuoteMark(options);
            var cssescopts = CSSESC_QUOTE_OPTIONS[quoteMark];
            var escaped = (0, cssesc_1.default)(this._value, cssescopts);
            return escaped;
          };
          Attribute2.prototype._determineQuoteMark = function(options) {
            return options.smart ? this.smartQuoteMark(options) : this.preferredQuoteMark(options);
          };
          Attribute2.prototype.setValue = function(value, options) {
            if (options === void 0) {
              options = {};
            }
            this._value = value;
            this._quoteMark = this._determineQuoteMark(options);
            this._syncRawValue();
          };
          Attribute2.prototype.smartQuoteMark = function(options) {
            var v2 = this.value;
            var numSingleQuotes = v2.replace(/[^']/g, "").length;
            var numDoubleQuotes = v2.replace(/[^"]/g, "").length;
            if (numSingleQuotes + numDoubleQuotes === 0) {
              var escaped = (0, cssesc_1.default)(v2, { isIdentifier: true });
              if (escaped === v2) {
                return Attribute2.NO_QUOTE;
              } else {
                var pref = this.preferredQuoteMark(options);
                if (pref === Attribute2.NO_QUOTE) {
                  var quote = this.quoteMark || options.quoteMark || Attribute2.DOUBLE_QUOTE;
                  var opts = CSSESC_QUOTE_OPTIONS[quote];
                  var quoteValue = (0, cssesc_1.default)(v2, opts);
                  if (quoteValue.length < escaped.length) {
                    return quote;
                  }
                }
                return pref;
              }
            } else if (numDoubleQuotes === numSingleQuotes) {
              return this.preferredQuoteMark(options);
            } else if (numDoubleQuotes < numSingleQuotes) {
              return Attribute2.DOUBLE_QUOTE;
            } else {
              return Attribute2.SINGLE_QUOTE;
            }
          };
          Attribute2.prototype.preferredQuoteMark = function(options) {
            var quoteMark = options.preferCurrentQuoteMark ? this.quoteMark : options.quoteMark;
            if (quoteMark === void 0) {
              quoteMark = options.preferCurrentQuoteMark ? options.quoteMark : this.quoteMark;
            }
            if (quoteMark === void 0) {
              quoteMark = Attribute2.DOUBLE_QUOTE;
            }
            return quoteMark;
          };
          Object.defineProperty(Attribute2.prototype, "quoted", {
            get: function() {
              var qm = this.quoteMark;
              return qm === "'" || qm === '"';
            },
            set: function(value) {
              warnOfDeprecatedQuotedAssignment();
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Attribute2.prototype, "quoteMark", {
            /**
             * returns a single (`'`) or double (`"`) quote character if the value is quoted.
             * returns `null` if the value is not quoted.
             * returns `undefined` if the quotation state is unknown (this can happen when
             * the attribute is constructed without specifying a quote mark.)
             */
            get: function() {
              return this._quoteMark;
            },
            /**
             * Set the quote mark to be used by this attribute's value.
             * If the quote mark changes, the raw (escaped) value at `attr.raws.value` of the attribute
             * value is updated accordingly.
             *
             * @param {"'" | '"' | null} quoteMark The quote mark or `null` if the value should be unquoted.
             */
            set: function(quoteMark) {
              if (!this._constructed) {
                this._quoteMark = quoteMark;
                return;
              }
              if (this._quoteMark !== quoteMark) {
                this._quoteMark = quoteMark;
                this._syncRawValue();
              }
            },
            enumerable: false,
            configurable: true
          });
          Attribute2.prototype._syncRawValue = function() {
            var rawValue = (0, cssesc_1.default)(this._value, CSSESC_QUOTE_OPTIONS[this.quoteMark]);
            if (rawValue === this._value) {
              if (this.raws) {
                delete this.raws.value;
              }
            } else {
              this.raws.value = rawValue;
            }
          };
          Object.defineProperty(Attribute2.prototype, "qualifiedAttribute", {
            get: function() {
              return this.qualifiedName(this.raws.attribute || this.attribute);
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Attribute2.prototype, "insensitiveFlag", {
            get: function() {
              return this.insensitive ? "i" : "";
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Attribute2.prototype, "value", {
            get: function() {
              return this._value;
            },
            /**
             * Before 3.0, the value had to be set to an escaped value including any wrapped
             * quote marks. In 3.0, the semantics of `Attribute.value` changed so that the value
             * is unescaped during parsing and any quote marks are removed.
             *
             * Because the ambiguity of this semantic change, if you set `attr.value = newValue`,
             * a deprecation warning is raised when the new value contains any characters that would
             * require escaping (including if it contains wrapped quotes).
             *
             * Instead, you should call `attr.setValue(newValue, opts)` and pass options that describe
             * how the new value is quoted.
             */
            set: function(v2) {
              if (this._constructed) {
                var _a2 = unescapeValue(v2), deprecatedUsage = _a2.deprecatedUsage, unescaped = _a2.unescaped, quoteMark = _a2.quoteMark;
                if (deprecatedUsage) {
                  warnOfDeprecatedValueAssignment();
                }
                if (unescaped === this._value && quoteMark === this._quoteMark) {
                  return;
                }
                this._value = unescaped;
                this._quoteMark = quoteMark;
                this._syncRawValue();
              } else {
                this._value = v2;
              }
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Attribute2.prototype, "insensitive", {
            get: function() {
              return this._insensitive;
            },
            /**
             * Set the case insensitive flag.
             * If the case insensitive flag changes, the raw (escaped) value at `attr.raws.insensitiveFlag`
             * of the attribute is updated accordingly.
             *
             * @param {true | false} insensitive true if the attribute should match case-insensitively.
             */
            set: function(insensitive) {
              if (!insensitive) {
                this._insensitive = false;
                if (this.raws && (this.raws.insensitiveFlag === "I" || this.raws.insensitiveFlag === "i")) {
                  this.raws.insensitiveFlag = void 0;
                }
              }
              this._insensitive = insensitive;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Attribute2.prototype, "attribute", {
            get: function() {
              return this._attribute;
            },
            set: function(name) {
              this._handleEscapes("attribute", name);
              this._attribute = name;
            },
            enumerable: false,
            configurable: true
          });
          Attribute2.prototype._handleEscapes = function(prop, value) {
            if (this._constructed) {
              var escaped = (0, cssesc_1.default)(value, { isIdentifier: true });
              if (escaped !== value) {
                this.raws[prop] = escaped;
              } else {
                delete this.raws[prop];
              }
            }
          };
          Attribute2.prototype._spacesFor = function(name) {
            var attrSpaces = { before: "", after: "" };
            var spaces = this.spaces[name] || {};
            var rawSpaces = this.raws.spaces && this.raws.spaces[name] || {};
            return Object.assign(attrSpaces, spaces, rawSpaces);
          };
          Attribute2.prototype._stringFor = function(name, spaceName, concat) {
            if (spaceName === void 0) {
              spaceName = name;
            }
            if (concat === void 0) {
              concat = defaultAttrConcat;
            }
            var attrSpaces = this._spacesFor(spaceName);
            return concat(this.stringifyProperty(name), attrSpaces);
          };
          Attribute2.prototype.offsetOf = function(name) {
            var count = 1;
            var attributeSpaces = this._spacesFor("attribute");
            count += attributeSpaces.before.length;
            if (name === "namespace" || name === "ns") {
              return this.namespace ? count : -1;
            }
            if (name === "attributeNS") {
              return count;
            }
            count += this.namespaceString.length;
            if (this.namespace) {
              count += 1;
            }
            if (name === "attribute") {
              return count;
            }
            count += this.stringifyProperty("attribute").length;
            count += attributeSpaces.after.length;
            var operatorSpaces = this._spacesFor("operator");
            count += operatorSpaces.before.length;
            var operator = this.stringifyProperty("operator");
            if (name === "operator") {
              return operator ? count : -1;
            }
            count += operator.length;
            count += operatorSpaces.after.length;
            var valueSpaces = this._spacesFor("value");
            count += valueSpaces.before.length;
            var value = this.stringifyProperty("value");
            if (name === "value") {
              return value ? count : -1;
            }
            count += value.length;
            count += valueSpaces.after.length;
            var insensitiveSpaces = this._spacesFor("insensitive");
            count += insensitiveSpaces.before.length;
            if (name === "insensitive") {
              return this.insensitive ? count : -1;
            }
            return -1;
          };
          Attribute2.prototype.toString = function() {
            var _this = this;
            var selector = [this.rawSpaceBefore, "["];
            selector.push(this._stringFor("qualifiedAttribute", "attribute"));
            if (this.operator && (this.value || this.value === "")) {
              selector.push(this._stringFor("operator"));
              selector.push(this._stringFor("value"));
              selector.push(this._stringFor("insensitiveFlag", "insensitive", function(attrValue, attrSpaces) {
                if (attrValue.length > 0 && !_this.quoted && attrSpaces.before.length === 0 && !(_this.spaces.value && _this.spaces.value.after)) {
                  attrSpaces.before = " ";
                }
                return defaultAttrConcat(attrValue, attrSpaces);
              }));
            }
            selector.push("]");
            selector.push(this.rawSpaceAfter);
            return selector.join("");
          };
          Attribute2.NO_QUOTE = null;
          Attribute2.SINGLE_QUOTE = "'";
          Attribute2.DOUBLE_QUOTE = '"';
          return Attribute2;
        })(namespace_1.default)
      );
      exports.default = Attribute;
      var CSSESC_QUOTE_OPTIONS = (_a = {
        "'": { quotes: "single", wrap: true },
        '"': { quotes: "double", wrap: true }
      }, _a[null] = { isIdentifier: true }, _a);
      function defaultAttrConcat(attrValue, attrSpaces) {
        return "".concat(attrSpaces.before).concat(attrValue).concat(attrSpaces.after);
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/universal.js
  var require_universal = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/universal.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var namespace_1 = __importDefault(require_namespace());
      var types_1 = require_types();
      var Universal = (
        /** @class */
        (function(_super) {
          __extends(Universal2, _super);
          function Universal2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.UNIVERSAL;
            _this.value = "*";
            return _this;
          }
          return Universal2;
        })(namespace_1.default)
      );
      exports.default = Universal;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/combinator.js
  var require_combinator = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/combinator.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var Combinator = (
        /** @class */
        (function(_super) {
          __extends(Combinator2, _super);
          function Combinator2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.COMBINATOR;
            return _this;
          }
          return Combinator2;
        })(node_1.default)
      );
      exports.default = Combinator;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/nesting.js
  var require_nesting = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/nesting.js"(exports) {
      "use strict";
      var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
        var extendStatics = function(d2, b2) {
          extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d3, b3) {
            d3.__proto__ = b3;
          } || function(d3, b3) {
            for (var p2 in b3) if (Object.prototype.hasOwnProperty.call(b3, p2)) d3[p2] = b3[p2];
          };
          return extendStatics(d2, b2);
        };
        return function(d2, b2) {
          if (typeof b2 !== "function" && b2 !== null)
            throw new TypeError("Class extends value " + String(b2) + " is not a constructor or null");
          extendStatics(d2, b2);
          function __() {
            this.constructor = d2;
          }
          d2.prototype = b2 === null ? Object.create(b2) : (__.prototype = b2.prototype, new __());
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var node_1 = __importDefault(require_node2());
      var types_1 = require_types();
      var Nesting = (
        /** @class */
        (function(_super) {
          __extends(Nesting2, _super);
          function Nesting2(opts) {
            var _this = _super.call(this, opts) || this;
            _this.type = types_1.NESTING;
            _this.value = "&";
            return _this;
          }
          return Nesting2;
        })(node_1.default)
      );
      exports.default = Nesting;
    }
  });

  // node_modules/postcss-selector-parser/dist/sortAscending.js
  var require_sortAscending = __commonJS({
    "node_modules/postcss-selector-parser/dist/sortAscending.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = sortAscending;
      function sortAscending(list2) {
        return list2.sort(function(a2, b2) {
          return a2 - b2;
        });
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/tokenTypes.js
  var require_tokenTypes = __commonJS({
    "node_modules/postcss-selector-parser/dist/tokenTypes.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.combinator = exports.word = exports.comment = exports.str = exports.tab = exports.newline = exports.feed = exports.cr = exports.backslash = exports.bang = exports.slash = exports.doubleQuote = exports.singleQuote = exports.space = exports.greaterThan = exports.pipe = exports.equals = exports.plus = exports.caret = exports.tilde = exports.dollar = exports.closeSquare = exports.openSquare = exports.closeParenthesis = exports.openParenthesis = exports.semicolon = exports.colon = exports.comma = exports.at = exports.asterisk = exports.ampersand = void 0;
      exports.ampersand = 38;
      exports.asterisk = 42;
      exports.at = 64;
      exports.comma = 44;
      exports.colon = 58;
      exports.semicolon = 59;
      exports.openParenthesis = 40;
      exports.closeParenthesis = 41;
      exports.openSquare = 91;
      exports.closeSquare = 93;
      exports.dollar = 36;
      exports.tilde = 126;
      exports.caret = 94;
      exports.plus = 43;
      exports.equals = 61;
      exports.pipe = 124;
      exports.greaterThan = 62;
      exports.space = 32;
      exports.singleQuote = 39;
      exports.doubleQuote = 34;
      exports.slash = 47;
      exports.bang = 33;
      exports.backslash = 92;
      exports.cr = 13;
      exports.feed = 12;
      exports.newline = 10;
      exports.tab = 9;
      exports.str = exports.singleQuote;
      exports.comment = -1;
      exports.word = -2;
      exports.combinator = -3;
    }
  });

  // node_modules/postcss-selector-parser/dist/tokenize.js
  var require_tokenize2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/tokenize.js"(exports) {
      "use strict";
      var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        var desc = Object.getOwnPropertyDescriptor(m2, k2);
        if (!desc || ("get" in desc ? !m2.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m2[k2];
          } };
        }
        Object.defineProperty(o2, k22, desc);
      }) : (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        o2[k22] = m2[k2];
      }));
      var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o2, v2) {
        Object.defineProperty(o2, "default", { enumerable: true, value: v2 });
      }) : function(o2, v2) {
        o2["default"] = v2;
      });
      var __importStar = exports && exports.__importStar || /* @__PURE__ */ (function() {
        var ownKeys = function(o2) {
          ownKeys = Object.getOwnPropertyNames || function(o3) {
            var ar = [];
            for (var k2 in o3) if (Object.prototype.hasOwnProperty.call(o3, k2)) ar[ar.length] = k2;
            return ar;
          };
          return ownKeys(o2);
        };
        return function(mod) {
          if (mod && mod.__esModule) return mod;
          var result = {};
          if (mod != null) {
            for (var k2 = ownKeys(mod), i3 = 0; i3 < k2.length; i3++) if (k2[i3] !== "default") __createBinding(result, mod, k2[i3]);
          }
          __setModuleDefault(result, mod);
          return result;
        };
      })();
      var _a;
      var _b;
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.FIELDS = void 0;
      exports.default = tokenize;
      var t3 = __importStar(require_tokenTypes());
      var unescapable = (_a = {}, _a[t3.tab] = true, _a[t3.newline] = true, _a[t3.cr] = true, _a[t3.feed] = true, _a);
      var wordDelimiters = (_b = {}, _b[t3.space] = true, _b[t3.tab] = true, _b[t3.newline] = true, _b[t3.cr] = true, _b[t3.feed] = true, _b[t3.ampersand] = true, _b[t3.asterisk] = true, _b[t3.bang] = true, _b[t3.comma] = true, _b[t3.colon] = true, _b[t3.semicolon] = true, _b[t3.openParenthesis] = true, _b[t3.closeParenthesis] = true, _b[t3.openSquare] = true, _b[t3.closeSquare] = true, _b[t3.singleQuote] = true, _b[t3.doubleQuote] = true, _b[t3.plus] = true, _b[t3.pipe] = true, _b[t3.tilde] = true, _b[t3.greaterThan] = true, _b[t3.equals] = true, _b[t3.dollar] = true, _b[t3.caret] = true, _b[t3.slash] = true, _b);
      var hex = {};
      var hexChars = "0123456789abcdefABCDEF";
      for (i2 = 0; i2 < hexChars.length; i2++) {
        hex[hexChars.charCodeAt(i2)] = true;
      }
      var i2;
      function consumeWord(css, start) {
        var next = start;
        var code;
        do {
          code = css.charCodeAt(next);
          if (wordDelimiters[code]) {
            return next - 1;
          } else if (code === t3.backslash) {
            next = consumeEscape(css, next) + 1;
          } else {
            next++;
          }
        } while (next < css.length);
        return next - 1;
      }
      function consumeEscape(css, start) {
        var next = start;
        var code = css.charCodeAt(next + 1);
        if (unescapable[code]) {
        } else if (hex[code]) {
          var hexDigits = 0;
          do {
            next++;
            hexDigits++;
            code = css.charCodeAt(next + 1);
          } while (hex[code] && hexDigits < 6);
          if (hexDigits < 6 && code === t3.space) {
            next++;
          }
        } else {
          next++;
        }
        return next;
      }
      exports.FIELDS = {
        TYPE: 0,
        START_LINE: 1,
        START_COL: 2,
        END_LINE: 3,
        END_COL: 4,
        START_POS: 5,
        END_POS: 6
      };
      function tokenize(input) {
        var tokens = [];
        var css = input.css.valueOf();
        var length = css.length;
        var offset = -1;
        var line = 1;
        var start = 0;
        var end = 0;
        var code, content, endColumn, endLine, escaped, escapePos, last, lines, next, nextLine, nextOffset, quote, tokenType;
        function unclosed(what, fix) {
          if (input.safe) {
            css += fix;
            next = css.length - 1;
          } else {
            throw input.error("Unclosed " + what, line, start - offset, start);
          }
        }
        while (start < length) {
          code = css.charCodeAt(start);
          if (code === t3.newline) {
            offset = start;
            line += 1;
          }
          switch (code) {
            case t3.space:
            case t3.tab:
            case t3.newline:
            case t3.cr:
            case t3.feed:
              next = start;
              do {
                next += 1;
                code = css.charCodeAt(next);
                if (code === t3.newline) {
                  offset = next;
                  line += 1;
                }
              } while (code === t3.space || code === t3.newline || code === t3.tab || code === t3.cr || code === t3.feed);
              tokenType = t3.space;
              endLine = line;
              endColumn = next - offset - 1;
              end = next;
              break;
            case t3.plus:
            case t3.greaterThan:
            case t3.tilde:
            case t3.pipe:
              next = start;
              do {
                next += 1;
                code = css.charCodeAt(next);
              } while (code === t3.plus || code === t3.greaterThan || code === t3.tilde || code === t3.pipe);
              tokenType = t3.combinator;
              endLine = line;
              endColumn = start - offset;
              end = next;
              break;
            // Consume these characters as single tokens.
            case t3.asterisk:
            case t3.ampersand:
            case t3.bang:
            case t3.comma:
            case t3.equals:
            case t3.dollar:
            case t3.caret:
            case t3.openSquare:
            case t3.closeSquare:
            case t3.colon:
            case t3.semicolon:
            case t3.openParenthesis:
            case t3.closeParenthesis:
              next = start;
              tokenType = code;
              endLine = line;
              endColumn = start - offset;
              end = next + 1;
              break;
            case t3.singleQuote:
            case t3.doubleQuote:
              quote = code === t3.singleQuote ? "'" : '"';
              next = start;
              do {
                escaped = false;
                next = css.indexOf(quote, next + 1);
                if (next === -1) {
                  unclosed("quote", quote);
                }
                escapePos = next;
                while (css.charCodeAt(escapePos - 1) === t3.backslash) {
                  escapePos -= 1;
                  escaped = !escaped;
                }
              } while (escaped);
              tokenType = t3.str;
              endLine = line;
              endColumn = start - offset;
              end = next + 1;
              break;
            default:
              if (code === t3.slash && css.charCodeAt(start + 1) === t3.asterisk) {
                next = css.indexOf("*/", start + 2) + 1;
                if (next === 0) {
                  unclosed("comment", "*/");
                }
                content = css.slice(start, next + 1);
                lines = content.split("\n");
                last = lines.length - 1;
                if (last > 0) {
                  nextLine = line + last;
                  nextOffset = next - lines[last].length;
                } else {
                  nextLine = line;
                  nextOffset = offset;
                }
                tokenType = t3.comment;
                line = nextLine;
                endLine = nextLine;
                endColumn = next - nextOffset;
              } else if (code === t3.slash) {
                next = start;
                tokenType = code;
                endLine = line;
                endColumn = start - offset;
                end = next + 1;
              } else {
                next = consumeWord(css, start);
                tokenType = t3.word;
                endLine = line;
                endColumn = next - offset;
              }
              end = next + 1;
              break;
          }
          tokens.push([
            tokenType,
            // [0] Token type
            line,
            // [1] Starting line
            start - offset,
            // [2] Starting column
            endLine,
            // [3] Ending line
            endColumn,
            // [4] Ending column
            start,
            // [5] Start position / Source index
            end
            // [6] End position
          ]);
          if (nextOffset) {
            offset = nextOffset;
            nextOffset = null;
          }
          start = end;
        }
        return tokens;
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/parser.js
  var require_parser2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/parser.js"(exports) {
      "use strict";
      var __assign = exports && exports.__assign || function() {
        __assign = Object.assign || function(t3) {
          for (var s2, i2 = 1, n2 = arguments.length; i2 < n2; i2++) {
            s2 = arguments[i2];
            for (var p2 in s2) if (Object.prototype.hasOwnProperty.call(s2, p2))
              t3[p2] = s2[p2];
          }
          return t3;
        };
        return __assign.apply(this, arguments);
      };
      var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        var desc = Object.getOwnPropertyDescriptor(m2, k2);
        if (!desc || ("get" in desc ? !m2.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m2[k2];
          } };
        }
        Object.defineProperty(o2, k22, desc);
      }) : (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        o2[k22] = m2[k2];
      }));
      var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o2, v2) {
        Object.defineProperty(o2, "default", { enumerable: true, value: v2 });
      }) : function(o2, v2) {
        o2["default"] = v2;
      });
      var __importStar = exports && exports.__importStar || /* @__PURE__ */ (function() {
        var ownKeys = function(o2) {
          ownKeys = Object.getOwnPropertyNames || function(o3) {
            var ar = [];
            for (var k2 in o3) if (Object.prototype.hasOwnProperty.call(o3, k2)) ar[ar.length] = k2;
            return ar;
          };
          return ownKeys(o2);
        };
        return function(mod) {
          if (mod && mod.__esModule) return mod;
          var result = {};
          if (mod != null) {
            for (var k2 = ownKeys(mod), i2 = 0; i2 < k2.length; i2++) if (k2[i2] !== "default") __createBinding(result, mod, k2[i2]);
          }
          __setModuleDefault(result, mod);
          return result;
        };
      })();
      var __read = exports && exports.__read || function(o2, n2) {
        var m2 = typeof Symbol === "function" && o2[Symbol.iterator];
        if (!m2) return o2;
        var i2 = m2.call(o2), r2, ar = [], e4;
        try {
          while ((n2 === void 0 || n2-- > 0) && !(r2 = i2.next()).done) ar.push(r2.value);
        } catch (error) {
          e4 = { error };
        } finally {
          try {
            if (r2 && !r2.done && (m2 = i2["return"])) m2.call(i2);
          } finally {
            if (e4) throw e4.error;
          }
        }
        return ar;
      };
      var __spreadArray = exports && exports.__spreadArray || function(to, from, pack) {
        if (pack || arguments.length === 2) for (var i2 = 0, l2 = from.length, ar; i2 < l2; i2++) {
          if (ar || !(i2 in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i2);
            ar[i2] = from[i2];
          }
        }
        return to.concat(ar || Array.prototype.slice.call(from));
      };
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      var _a;
      var _b;
      Object.defineProperty(exports, "__esModule", { value: true });
      var root_1 = __importDefault(require_root2());
      var selector_1 = __importDefault(require_selector());
      var className_1 = __importDefault(require_className());
      var comment_1 = __importDefault(require_comment2());
      var id_1 = __importDefault(require_id());
      var tag_1 = __importDefault(require_tag());
      var string_1 = __importDefault(require_string());
      var pseudo_1 = __importDefault(require_pseudo());
      var attribute_1 = __importStar(require_attribute());
      var universal_1 = __importDefault(require_universal());
      var combinator_1 = __importDefault(require_combinator());
      var nesting_1 = __importDefault(require_nesting());
      var sortAscending_1 = __importDefault(require_sortAscending());
      var tokenize_1 = __importStar(require_tokenize2());
      var tokens = __importStar(require_tokenTypes());
      var types = __importStar(require_types());
      var util_1 = require_util();
      var WHITESPACE_TOKENS = (_a = {}, _a[tokens.space] = true, _a[tokens.cr] = true, _a[tokens.feed] = true, _a[tokens.newline] = true, _a[tokens.tab] = true, _a);
      var WHITESPACE_EQUIV_TOKENS = __assign(__assign({}, WHITESPACE_TOKENS), (_b = {}, _b[tokens.comment] = true, _b));
      function tokenStart(token) {
        return {
          line: token[tokenize_1.FIELDS.START_LINE],
          column: token[tokenize_1.FIELDS.START_COL]
        };
      }
      function tokenEnd(token) {
        return {
          line: token[tokenize_1.FIELDS.END_LINE],
          column: token[tokenize_1.FIELDS.END_COL]
        };
      }
      function getSource(startLine, startColumn, endLine, endColumn) {
        return {
          start: {
            line: startLine,
            column: startColumn
          },
          end: {
            line: endLine,
            column: endColumn
          }
        };
      }
      function getTokenSource(token) {
        return getSource(token[tokenize_1.FIELDS.START_LINE], token[tokenize_1.FIELDS.START_COL], token[tokenize_1.FIELDS.END_LINE], token[tokenize_1.FIELDS.END_COL]);
      }
      function getTokenSourceSpan(startToken, endToken) {
        if (!startToken) {
          return void 0;
        }
        return getSource(startToken[tokenize_1.FIELDS.START_LINE], startToken[tokenize_1.FIELDS.START_COL], endToken[tokenize_1.FIELDS.END_LINE], endToken[tokenize_1.FIELDS.END_COL]);
      }
      function unescapeProp(node, prop) {
        var value = node[prop];
        if (typeof value !== "string") {
          return;
        }
        if (value.indexOf("\\") !== -1) {
          (0, util_1.ensureObject)(node, "raws");
          node[prop] = (0, util_1.unesc)(value);
          if (node.raws[prop] === void 0) {
            node.raws[prop] = value;
          }
        }
        return node;
      }
      function indexesOf(array, item) {
        var i2 = -1;
        var indexes = [];
        while ((i2 = array.indexOf(item, i2 + 1)) !== -1) {
          indexes.push(i2);
        }
        return indexes;
      }
      function uniqs() {
        var list2 = Array.prototype.concat.apply([], arguments);
        return list2.filter(function(item, i2) {
          return i2 === list2.indexOf(item);
        });
      }
      var Parser = (
        /** @class */
        (function() {
          function Parser2(rule2, options) {
            if (options === void 0) {
              options = {};
            }
            this.rule = rule2;
            this.options = Object.assign({ lossy: false, safe: false }, options);
            this.position = 0;
            this.nestingDepth = 0;
            this.maxNestingDepth = (0, util_1.resolveMaxNestingDepth)(this.options.maxNestingDepth);
            this.css = typeof this.rule === "string" ? this.rule : this.rule.selector;
            this.tokens = (0, tokenize_1.default)({
              css: this.css,
              error: this._errorGenerator(),
              safe: this.options.safe
            });
            var rootSource = getTokenSourceSpan(this.tokens[0], this.tokens[this.tokens.length - 1]);
            this.root = new root_1.default({ source: rootSource });
            this.root.errorGenerator = this._errorGenerator();
            var selector = new selector_1.default({
              source: { start: { line: 1, column: 1 } },
              sourceIndex: 0
            });
            this.root.append(selector);
            this.current = selector;
            this.loop();
          }
          Parser2.prototype._errorGenerator = function() {
            var _this = this;
            return function(message, errorOptions) {
              if (typeof _this.rule === "string") {
                return new Error(message);
              }
              return _this.rule.error(message, errorOptions);
            };
          };
          Parser2.prototype.attribute = function() {
            var attr = [];
            var startingToken = this.currToken;
            this.position++;
            while (this.position < this.tokens.length && this.currToken[tokenize_1.FIELDS.TYPE] !== tokens.closeSquare) {
              attr.push(this.currToken);
              this.position++;
            }
            if (this.currToken[tokenize_1.FIELDS.TYPE] !== tokens.closeSquare) {
              return this.expected("closing square bracket", this.currToken[tokenize_1.FIELDS.START_POS]);
            }
            var len = attr.length;
            var node = {
              source: getSource(startingToken[1], startingToken[2], this.currToken[3], this.currToken[4]),
              sourceIndex: startingToken[tokenize_1.FIELDS.START_POS]
            };
            if (len === 1 && !~[tokens.word].indexOf(attr[0][tokenize_1.FIELDS.TYPE])) {
              return this.expected("attribute", attr[0][tokenize_1.FIELDS.START_POS]);
            }
            var pos = 0;
            var spaceBefore = "";
            var commentBefore = "";
            var lastAdded = null;
            var spaceAfterMeaningfulToken = false;
            while (pos < len) {
              var token = attr[pos];
              var content = this.content(token);
              var next = attr[pos + 1];
              switch (token[tokenize_1.FIELDS.TYPE]) {
                case tokens.space:
                  spaceAfterMeaningfulToken = true;
                  if (this.options.lossy) {
                    break;
                  }
                  if (lastAdded) {
                    (0, util_1.ensureObject)(node, "spaces", lastAdded);
                    var prevContent = node.spaces[lastAdded].after || "";
                    node.spaces[lastAdded].after = prevContent + content;
                    var existingComment = (0, util_1.getProp)(node, "raws", "spaces", lastAdded, "after") || null;
                    if (existingComment) {
                      node.raws.spaces[lastAdded].after = existingComment + content;
                    }
                  } else {
                    spaceBefore = spaceBefore + content;
                    commentBefore = commentBefore + content;
                  }
                  break;
                case tokens.asterisk:
                  if (next[tokenize_1.FIELDS.TYPE] === tokens.equals) {
                    node.operator = content;
                    lastAdded = "operator";
                  } else if ((!node.namespace || lastAdded === "namespace" && !spaceAfterMeaningfulToken) && next) {
                    if (spaceBefore) {
                      (0, util_1.ensureObject)(node, "spaces", "attribute");
                      node.spaces.attribute.before = spaceBefore;
                      spaceBefore = "";
                    }
                    if (commentBefore) {
                      (0, util_1.ensureObject)(node, "raws", "spaces", "attribute");
                      node.raws.spaces.attribute.before = spaceBefore;
                      commentBefore = "";
                    }
                    node.namespace = (node.namespace || "") + content;
                    var rawValue = (0, util_1.getProp)(node, "raws", "namespace") || null;
                    if (rawValue) {
                      node.raws.namespace += content;
                    }
                    lastAdded = "namespace";
                  }
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.dollar:
                  if (lastAdded === "value") {
                    var oldRawValue = (0, util_1.getProp)(node, "raws", "value");
                    node.value += "$";
                    if (oldRawValue) {
                      node.raws.value = oldRawValue + "$";
                    }
                    break;
                  }
                // Falls through
                case tokens.caret:
                  if (next[tokenize_1.FIELDS.TYPE] === tokens.equals) {
                    node.operator = content;
                    lastAdded = "operator";
                  }
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.combinator:
                  if (content === "~" && next[tokenize_1.FIELDS.TYPE] === tokens.equals) {
                    node.operator = content;
                    lastAdded = "operator";
                  }
                  if (content !== "|") {
                    spaceAfterMeaningfulToken = false;
                    break;
                  }
                  if (next[tokenize_1.FIELDS.TYPE] === tokens.equals) {
                    node.operator = content;
                    lastAdded = "operator";
                  } else if (!node.namespace && !node.attribute) {
                    node.namespace = true;
                  }
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.word:
                  if (next && this.content(next) === "|" && attr[pos + 2] && attr[pos + 2][tokenize_1.FIELDS.TYPE] !== tokens.equals && // this look-ahead probably fails with comment nodes involved.
                  !node.operator && !node.namespace) {
                    node.namespace = content;
                    lastAdded = "namespace";
                  } else if (!node.attribute || lastAdded === "attribute" && !spaceAfterMeaningfulToken) {
                    if (spaceBefore) {
                      (0, util_1.ensureObject)(node, "spaces", "attribute");
                      node.spaces.attribute.before = spaceBefore;
                      spaceBefore = "";
                    }
                    if (commentBefore) {
                      (0, util_1.ensureObject)(node, "raws", "spaces", "attribute");
                      node.raws.spaces.attribute.before = commentBefore;
                      commentBefore = "";
                    }
                    node.attribute = (node.attribute || "") + content;
                    var rawValue = (0, util_1.getProp)(node, "raws", "attribute") || null;
                    if (rawValue) {
                      node.raws.attribute += content;
                    }
                    lastAdded = "attribute";
                  } else if (!node.value && node.value !== "" || lastAdded === "value" && !(spaceAfterMeaningfulToken || node.quoteMark)) {
                    var unescaped_1 = (0, util_1.unesc)(content);
                    var oldRawValue = (0, util_1.getProp)(node, "raws", "value") || "";
                    var oldValue = node.value || "";
                    node.value = oldValue + unescaped_1;
                    node.quoteMark = null;
                    if (unescaped_1 !== content || oldRawValue) {
                      (0, util_1.ensureObject)(node, "raws");
                      node.raws.value = (oldRawValue || oldValue) + content;
                    }
                    lastAdded = "value";
                  } else {
                    var insensitive = content === "i" || content === "I";
                    if ((node.value || node.value === "") && (node.quoteMark || spaceAfterMeaningfulToken)) {
                      node.insensitive = insensitive;
                      if (!insensitive || content === "I") {
                        (0, util_1.ensureObject)(node, "raws");
                        node.raws.insensitiveFlag = content;
                      }
                      lastAdded = "insensitive";
                      if (spaceBefore) {
                        (0, util_1.ensureObject)(node, "spaces", "insensitive");
                        node.spaces.insensitive.before = spaceBefore;
                        spaceBefore = "";
                      }
                      if (commentBefore) {
                        (0, util_1.ensureObject)(node, "raws", "spaces", "insensitive");
                        node.raws.spaces.insensitive.before = commentBefore;
                        commentBefore = "";
                      }
                    } else if (node.value || node.value === "") {
                      lastAdded = "value";
                      node.value += content;
                      if (node.raws.value) {
                        node.raws.value += content;
                      }
                    }
                  }
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.str:
                  if (!node.attribute || !node.operator) {
                    return this.error("Expected an attribute followed by an operator preceding the string.", {
                      index: token[tokenize_1.FIELDS.START_POS]
                    });
                  }
                  var _a2 = (0, attribute_1.unescapeValue)(content), unescaped = _a2.unescaped, quoteMark = _a2.quoteMark;
                  node.value = unescaped;
                  node.quoteMark = quoteMark;
                  lastAdded = "value";
                  (0, util_1.ensureObject)(node, "raws");
                  node.raws.value = content;
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.equals:
                  if (!node.attribute) {
                    return this.expected("attribute", token[tokenize_1.FIELDS.START_POS], content);
                  }
                  if (node.value) {
                    return this.error('Unexpected "=" found; an operator was already defined.', {
                      index: token[tokenize_1.FIELDS.START_POS]
                    });
                  }
                  node.operator = node.operator ? node.operator + content : content;
                  lastAdded = "operator";
                  spaceAfterMeaningfulToken = false;
                  break;
                case tokens.comment:
                  if (lastAdded) {
                    if (spaceAfterMeaningfulToken || next && next[tokenize_1.FIELDS.TYPE] === tokens.space || lastAdded === "insensitive") {
                      var lastComment = (0, util_1.getProp)(node, "spaces", lastAdded, "after") || "";
                      var rawLastComment = (0, util_1.getProp)(node, "raws", "spaces", lastAdded, "after") || lastComment;
                      (0, util_1.ensureObject)(node, "raws", "spaces", lastAdded);
                      node.raws.spaces[lastAdded].after = rawLastComment + content;
                    } else {
                      var lastValue = node[lastAdded] || "";
                      var rawLastValue = (0, util_1.getProp)(node, "raws", lastAdded) || lastValue;
                      (0, util_1.ensureObject)(node, "raws");
                      node.raws[lastAdded] = rawLastValue + content;
                    }
                  } else {
                    commentBefore = commentBefore + content;
                  }
                  break;
                default:
                  return this.error('Unexpected "'.concat(content, '" found.'), { index: token[tokenize_1.FIELDS.START_POS] });
              }
              pos++;
            }
            unescapeProp(node, "attribute");
            unescapeProp(node, "namespace");
            this.newNode(new attribute_1.default(node));
            this.position++;
          };
          Parser2.prototype.parseWhitespaceEquivalentTokens = function(stopPosition) {
            if (stopPosition < 0) {
              stopPosition = this.tokens.length;
            }
            var startPosition = this.position;
            var nodes = [];
            var space = "";
            var lastComment = void 0;
            do {
              if (WHITESPACE_TOKENS[this.currToken[tokenize_1.FIELDS.TYPE]]) {
                if (!this.options.lossy) {
                  space += this.content();
                }
              } else if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.comment) {
                var spaces = {};
                if (space) {
                  spaces.before = space;
                  space = "";
                }
                lastComment = new comment_1.default({
                  value: this.content(),
                  source: getTokenSource(this.currToken),
                  sourceIndex: this.currToken[tokenize_1.FIELDS.START_POS],
                  spaces
                });
                nodes.push(lastComment);
              }
            } while (++this.position < stopPosition);
            if (space) {
              if (lastComment) {
                lastComment.spaces.after = space;
              } else if (!this.options.lossy) {
                var firstToken = this.tokens[startPosition];
                var lastToken = this.tokens[this.position - 1];
                nodes.push(new string_1.default({
                  value: "",
                  source: getSource(firstToken[tokenize_1.FIELDS.START_LINE], firstToken[tokenize_1.FIELDS.START_COL], lastToken[tokenize_1.FIELDS.END_LINE], lastToken[tokenize_1.FIELDS.END_COL]),
                  sourceIndex: firstToken[tokenize_1.FIELDS.START_POS],
                  spaces: { before: space, after: "" }
                }));
              }
            }
            return nodes;
          };
          Parser2.prototype.convertWhitespaceNodesToSpace = function(nodes, requiredSpace) {
            var _this = this;
            if (requiredSpace === void 0) {
              requiredSpace = false;
            }
            var space = "";
            var rawSpace = "";
            nodes.forEach(function(n2) {
              var spaceBefore = _this.lossySpace(n2.spaces.before, requiredSpace);
              var rawSpaceBefore = _this.lossySpace(n2.rawSpaceBefore, requiredSpace);
              space += spaceBefore + _this.lossySpace(n2.spaces.after, requiredSpace && spaceBefore.length === 0);
              rawSpace += spaceBefore + n2.value + _this.lossySpace(n2.rawSpaceAfter, requiredSpace && rawSpaceBefore.length === 0);
            });
            if (rawSpace === space) {
              rawSpace = void 0;
            }
            var result = { space, rawSpace };
            return result;
          };
          Parser2.prototype.isNamedCombinator = function(position) {
            if (position === void 0) {
              position = this.position;
            }
            return this.tokens[position + 0] && this.tokens[position + 0][tokenize_1.FIELDS.TYPE] === tokens.slash && this.tokens[position + 1] && this.tokens[position + 1][tokenize_1.FIELDS.TYPE] === tokens.word && this.tokens[position + 2] && this.tokens[position + 2][tokenize_1.FIELDS.TYPE] === tokens.slash;
          };
          Parser2.prototype.namedCombinator = function() {
            if (this.isNamedCombinator()) {
              var nameRaw = this.content(this.tokens[this.position + 1]);
              var name = (0, util_1.unesc)(nameRaw).toLowerCase();
              var raws = {};
              if (name !== nameRaw) {
                raws.value = "/".concat(nameRaw, "/");
              }
              var node = new combinator_1.default({
                value: "/".concat(name, "/"),
                source: getSource(this.currToken[tokenize_1.FIELDS.START_LINE], this.currToken[tokenize_1.FIELDS.START_COL], this.tokens[this.position + 2][tokenize_1.FIELDS.END_LINE], this.tokens[this.position + 2][tokenize_1.FIELDS.END_COL]),
                sourceIndex: this.currToken[tokenize_1.FIELDS.START_POS],
                raws
              });
              this.position = this.position + 3;
              return node;
            } else {
              this.unexpected();
            }
          };
          Parser2.prototype.combinator = function() {
            var _this = this;
            if (this.content() === "|") {
              return this.namespace();
            }
            var nextSigTokenPos = this.locateNextMeaningfulToken(this.position);
            if (nextSigTokenPos < 0 || this.tokens[nextSigTokenPos][tokenize_1.FIELDS.TYPE] === tokens.comma || this.tokens[nextSigTokenPos][tokenize_1.FIELDS.TYPE] === tokens.closeParenthesis) {
              var nodes = this.parseWhitespaceEquivalentTokens(nextSigTokenPos);
              if (nodes.length > 0) {
                var last = this.current.last;
                if (last) {
                  var _a2 = this.convertWhitespaceNodesToSpace(nodes), space = _a2.space, rawSpace = _a2.rawSpace;
                  if (rawSpace !== void 0) {
                    last.rawSpaceAfter += rawSpace;
                  }
                  last.spaces.after += space;
                } else {
                  nodes.forEach(function(n2) {
                    return _this.newNode(n2);
                  });
                }
              }
              return;
            }
            var firstToken = this.currToken;
            var spaceOrDescendantSelectorNodes = void 0;
            if (nextSigTokenPos > this.position) {
              spaceOrDescendantSelectorNodes = this.parseWhitespaceEquivalentTokens(nextSigTokenPos);
            }
            var node;
            if (this.isNamedCombinator()) {
              node = this.namedCombinator();
            } else if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.combinator) {
              node = new combinator_1.default({
                value: this.content(),
                source: getTokenSource(this.currToken),
                sourceIndex: this.currToken[tokenize_1.FIELDS.START_POS]
              });
              this.position++;
            } else if (WHITESPACE_TOKENS[this.currToken[tokenize_1.FIELDS.TYPE]]) {
            } else if (!spaceOrDescendantSelectorNodes) {
              this.unexpected();
            }
            if (node) {
              if (spaceOrDescendantSelectorNodes) {
                var _b2 = this.convertWhitespaceNodesToSpace(spaceOrDescendantSelectorNodes), space = _b2.space, rawSpace = _b2.rawSpace;
                node.spaces.before = space;
                node.rawSpaceBefore = rawSpace;
              }
            } else {
              var _c = this.convertWhitespaceNodesToSpace(spaceOrDescendantSelectorNodes, true), space = _c.space, rawSpace = _c.rawSpace;
              if (!rawSpace) {
                rawSpace = space;
              }
              var spaces = {};
              var raws = { spaces: {} };
              if (space.endsWith(" ") && rawSpace.endsWith(" ")) {
                spaces.before = space.slice(0, space.length - 1);
                raws.spaces.before = rawSpace.slice(0, rawSpace.length - 1);
              } else if (space[0] === " " && rawSpace[0] === " ") {
                spaces.after = space.slice(1);
                raws.spaces.after = rawSpace.slice(1);
              } else {
                raws.value = rawSpace;
              }
              node = new combinator_1.default({
                value: " ",
                source: getTokenSourceSpan(firstToken, this.tokens[this.position - 1]),
                sourceIndex: firstToken[tokenize_1.FIELDS.START_POS],
                spaces,
                raws
              });
            }
            if (this.currToken && this.currToken[tokenize_1.FIELDS.TYPE] === tokens.space) {
              node.spaces.after = this.optionalSpace(this.content());
              this.position++;
            }
            return this.newNode(node);
          };
          Parser2.prototype.comma = function() {
            if (this.position === this.tokens.length - 1) {
              this.root.trailingComma = true;
              this.position++;
              return;
            }
            this.current._inferEndPosition();
            var selector = new selector_1.default({
              source: {
                start: tokenStart(this.tokens[this.position + 1])
              },
              sourceIndex: this.tokens[this.position + 1][tokenize_1.FIELDS.START_POS]
            });
            this.current.parent.append(selector);
            this.current = selector;
            this.position++;
          };
          Parser2.prototype.comment = function() {
            var current = this.currToken;
            this.newNode(new comment_1.default({
              value: this.content(),
              source: getTokenSource(current),
              sourceIndex: current[tokenize_1.FIELDS.START_POS]
            }));
            this.position++;
          };
          Parser2.prototype.error = function(message, opts) {
            throw this.root.error(message, opts);
          };
          Parser2.prototype.missingBackslash = function() {
            return this.error("Expected a backslash preceding the semicolon.", {
              index: this.currToken[tokenize_1.FIELDS.START_POS]
            });
          };
          Parser2.prototype.missingParenthesis = function() {
            return this.expected("opening parenthesis", this.currToken[tokenize_1.FIELDS.START_POS]);
          };
          Parser2.prototype.missingSquareBracket = function() {
            return this.expected("opening square bracket", this.currToken[tokenize_1.FIELDS.START_POS]);
          };
          Parser2.prototype.unexpected = function() {
            return this.error("Unexpected '".concat(this.content(), "'. Escaping special characters with \\ may help."), this.currToken[tokenize_1.FIELDS.START_POS]);
          };
          Parser2.prototype.unexpectedPipe = function() {
            return this.error("Unexpected '|'.", this.currToken[tokenize_1.FIELDS.START_POS]);
          };
          Parser2.prototype.namespace = function() {
            var before = this.prevToken && this.content(this.prevToken) || true;
            if (this.nextToken[tokenize_1.FIELDS.TYPE] === tokens.word) {
              this.position++;
              return this.word(before);
            } else if (this.nextToken[tokenize_1.FIELDS.TYPE] === tokens.asterisk) {
              this.position++;
              return this.universal(before);
            }
            this.unexpectedPipe();
          };
          Parser2.prototype.nesting = function() {
            if (this.nextToken) {
              var nextContent = this.content(this.nextToken);
              if (nextContent === "|") {
                this.position++;
                return;
              }
            }
            var current = this.currToken;
            this.newNode(new nesting_1.default({
              value: this.content(),
              source: getTokenSource(current),
              sourceIndex: current[tokenize_1.FIELDS.START_POS]
            }));
            this.position++;
          };
          Parser2.prototype.parentheses = function() {
            var last = this.current.last;
            var unbalanced = 1;
            this.position++;
            if (last && last.type === types.PSEUDO) {
              var selector = new selector_1.default({
                source: { start: tokenStart(this.tokens[this.position]) },
                sourceIndex: this.tokens[this.position][tokenize_1.FIELDS.START_POS]
              });
              var cache = this.current;
              last.append(selector);
              this.current = selector;
              this.nestingDepth++;
              try {
                if (this.nestingDepth > this.maxNestingDepth) {
                  this.error("Cannot parse selector: nesting depth exceeds the maximum of ".concat(this.maxNestingDepth, "."), { index: this.currToken[tokenize_1.FIELDS.START_POS] });
                }
                while (this.position < this.tokens.length && unbalanced) {
                  if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.openParenthesis) {
                    unbalanced++;
                  }
                  if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.closeParenthesis) {
                    unbalanced--;
                  }
                  if (unbalanced) {
                    this.parse();
                  } else {
                    this.current.source.end = tokenEnd(this.currToken);
                    this.current.parent.source.end = tokenEnd(this.currToken);
                    this.position++;
                  }
                }
              } finally {
                this.nestingDepth--;
              }
              this.current = cache;
            } else {
              var parenStart = this.currToken;
              var parenValue = "(";
              var parenEnd = void 0;
              while (this.position < this.tokens.length && unbalanced) {
                if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.openParenthesis) {
                  unbalanced++;
                }
                if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.closeParenthesis) {
                  unbalanced--;
                }
                parenEnd = this.currToken;
                parenValue += this.parseParenthesisToken(this.currToken);
                this.position++;
              }
              if (last) {
                last.appendToPropertyAndEscape("value", parenValue, parenValue);
              } else {
                this.newNode(new string_1.default({
                  value: parenValue,
                  source: getSource(parenStart[tokenize_1.FIELDS.START_LINE], parenStart[tokenize_1.FIELDS.START_COL], parenEnd[tokenize_1.FIELDS.END_LINE], parenEnd[tokenize_1.FIELDS.END_COL]),
                  sourceIndex: parenStart[tokenize_1.FIELDS.START_POS]
                }));
              }
            }
            if (unbalanced) {
              return this.expected("closing parenthesis", this.currToken[tokenize_1.FIELDS.START_POS]);
            }
          };
          Parser2.prototype.pseudo = function() {
            var _this = this;
            var pseudoStr = "";
            var startingToken = this.currToken;
            while (this.currToken && this.currToken[tokenize_1.FIELDS.TYPE] === tokens.colon) {
              pseudoStr += this.content();
              this.position++;
            }
            if (!this.currToken) {
              return this.expected(["pseudo-class", "pseudo-element"], this.position - 1);
            }
            if (this.currToken[tokenize_1.FIELDS.TYPE] === tokens.word) {
              this.splitWord(false, function(first, length) {
                pseudoStr += first;
                _this.newNode(new pseudo_1.default({
                  value: pseudoStr,
                  source: getTokenSourceSpan(startingToken, _this.currToken),
                  sourceIndex: startingToken[tokenize_1.FIELDS.START_POS]
                }));
                if (length > 1 && _this.nextToken && _this.nextToken[tokenize_1.FIELDS.TYPE] === tokens.openParenthesis) {
                  _this.error("Misplaced parenthesis.", {
                    index: _this.nextToken[tokenize_1.FIELDS.START_POS]
                  });
                }
              });
            } else {
              return this.expected(["pseudo-class", "pseudo-element"], this.currToken[tokenize_1.FIELDS.START_POS]);
            }
          };
          Parser2.prototype.space = function() {
            var content = this.content();
            if (this.position === 0 || this.prevToken[tokenize_1.FIELDS.TYPE] === tokens.comma || this.prevToken[tokenize_1.FIELDS.TYPE] === tokens.openParenthesis || this.current.nodes.every(function(node) {
              return node.type === "comment";
            })) {
              this.spaces = this.optionalSpace(content);
              this.position++;
            } else if (this.position === this.tokens.length - 1 || this.nextToken[tokenize_1.FIELDS.TYPE] === tokens.comma || this.nextToken[tokenize_1.FIELDS.TYPE] === tokens.closeParenthesis) {
              this.current.last.spaces.after = this.optionalSpace(content);
              this.position++;
            } else {
              this.combinator();
            }
          };
          Parser2.prototype.string = function() {
            var current = this.currToken;
            this.newNode(new string_1.default({
              value: this.content(),
              source: getTokenSource(current),
              sourceIndex: current[tokenize_1.FIELDS.START_POS]
            }));
            this.position++;
          };
          Parser2.prototype.universal = function(namespace) {
            var nextToken = this.nextToken;
            if (nextToken && this.content(nextToken) === "|") {
              this.position++;
              return this.namespace();
            }
            var current = this.currToken;
            this.newNode(new universal_1.default({
              value: this.content(),
              source: getTokenSource(current),
              sourceIndex: current[tokenize_1.FIELDS.START_POS]
            }), namespace);
            this.position++;
          };
          Parser2.prototype.splitWord = function(namespace, firstCallback) {
            var _this = this;
            var nextToken = this.nextToken;
            var word = this.content();
            while (nextToken && ~[tokens.dollar, tokens.caret, tokens.equals, tokens.word].indexOf(nextToken[tokenize_1.FIELDS.TYPE])) {
              this.position++;
              var current = this.content();
              word += current;
              if (current.lastIndexOf("\\") === current.length - 1) {
                var next = this.nextToken;
                if (next && next[tokenize_1.FIELDS.TYPE] === tokens.space) {
                  word += this.requiredSpace(this.content(next));
                  this.position++;
                }
              }
              nextToken = this.nextToken;
            }
            var hasClass = indexesOf(word, ".").filter(function(i2) {
              var escapedDot = word[i2 - 1] === "\\";
              var isKeyframesPercent = /^\d+\.\d+%$/.test(word);
              return !escapedDot && !isKeyframesPercent;
            });
            var hasId = indexesOf(word, "#").filter(function(i2) {
              return word[i2 - 1] !== "\\";
            });
            var interpolations = indexesOf(word, "#{");
            if (interpolations.length) {
              hasId = hasId.filter(function(hashIndex) {
                return !~interpolations.indexOf(hashIndex);
              });
            }
            var indices = (0, sortAscending_1.default)(uniqs(__spreadArray(__spreadArray([0], __read(hasClass), false), __read(hasId), false)));
            indices.forEach(function(ind, i2) {
              var index = indices[i2 + 1] || word.length;
              var value = word.slice(ind, index);
              if (i2 === 0 && firstCallback) {
                return firstCallback.call(_this, value, indices.length);
              }
              var node;
              var current2 = _this.currToken;
              var sourceIndex = current2[tokenize_1.FIELDS.START_POS] + indices[i2];
              var source = getSource(current2[1], current2[2] + ind, current2[3], current2[2] + (index - 1));
              if (~hasClass.indexOf(ind)) {
                var classNameOpts = {
                  value: value.slice(1),
                  source,
                  sourceIndex
                };
                node = new className_1.default(unescapeProp(classNameOpts, "value"));
              } else if (~hasId.indexOf(ind)) {
                var idOpts = {
                  value: value.slice(1),
                  source,
                  sourceIndex
                };
                node = new id_1.default(unescapeProp(idOpts, "value"));
              } else {
                var tagOpts = {
                  value,
                  source,
                  sourceIndex
                };
                unescapeProp(tagOpts, "value");
                node = new tag_1.default(tagOpts);
              }
              _this.newNode(node, namespace);
              namespace = null;
            });
            this.position++;
          };
          Parser2.prototype.word = function(namespace) {
            var nextToken = this.nextToken;
            if (nextToken && this.content(nextToken) === "|") {
              this.position++;
              return this.namespace();
            }
            return this.splitWord(namespace);
          };
          Parser2.prototype.loop = function() {
            while (this.position < this.tokens.length) {
              this.parse(true);
            }
            this.current._inferEndPosition();
            return this.root;
          };
          Parser2.prototype.parse = function(throwOnParenthesis) {
            switch (this.currToken[tokenize_1.FIELDS.TYPE]) {
              case tokens.space:
                this.space();
                break;
              case tokens.comment:
                this.comment();
                break;
              case tokens.openParenthesis:
                this.parentheses();
                break;
              case tokens.closeParenthesis:
                if (throwOnParenthesis) {
                  this.missingParenthesis();
                }
                break;
              case tokens.openSquare:
                this.attribute();
                break;
              case tokens.dollar:
              case tokens.caret:
              case tokens.equals:
              case tokens.word:
                this.word();
                break;
              case tokens.colon:
                this.pseudo();
                break;
              case tokens.comma:
                this.comma();
                break;
              case tokens.asterisk:
                this.universal();
                break;
              case tokens.ampersand:
                this.nesting();
                break;
              case tokens.slash:
              case tokens.combinator:
                this.combinator();
                break;
              case tokens.str:
                this.string();
                break;
              // These cases throw; no break needed.
              case tokens.closeSquare:
                this.missingSquareBracket();
              case tokens.semicolon:
                this.missingBackslash();
              default:
                this.unexpected();
            }
          };
          Parser2.prototype.expected = function(description, index, found) {
            if (Array.isArray(description)) {
              var last = description.pop();
              description = "".concat(description.join(", "), " or ").concat(last);
            }
            var an = /^[aeiou]/.test(description[0]) ? "an" : "a";
            if (!found) {
              return this.error("Expected ".concat(an, " ").concat(description, "."), { index });
            }
            return this.error("Expected ".concat(an, " ").concat(description, ', found "').concat(found, '" instead.'), { index });
          };
          Parser2.prototype.requiredSpace = function(space) {
            return this.options.lossy ? " " : space;
          };
          Parser2.prototype.optionalSpace = function(space) {
            return this.options.lossy ? "" : space;
          };
          Parser2.prototype.lossySpace = function(space, required) {
            if (this.options.lossy) {
              return required ? " " : "";
            } else {
              return space;
            }
          };
          Parser2.prototype.parseParenthesisToken = function(token) {
            var content = this.content(token);
            if (token[tokenize_1.FIELDS.TYPE] === tokens.space) {
              return this.requiredSpace(content);
            } else {
              return content;
            }
          };
          Parser2.prototype.newNode = function(node, namespace) {
            if (namespace) {
              if (/^ +$/.test(namespace)) {
                if (!this.options.lossy) {
                  this.spaces = (this.spaces || "") + namespace;
                }
                namespace = true;
              }
              node.namespace = namespace;
              unescapeProp(node, "namespace");
            }
            if (this.spaces) {
              node.spaces.before = this.spaces;
              this.spaces = "";
            }
            return this.current.append(node);
          };
          Parser2.prototype.content = function(token) {
            if (token === void 0) {
              token = this.currToken;
            }
            return this.css.slice(token[tokenize_1.FIELDS.START_POS], token[tokenize_1.FIELDS.END_POS]);
          };
          Object.defineProperty(Parser2.prototype, "currToken", {
            get: function() {
              return this.tokens[this.position];
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Parser2.prototype, "nextToken", {
            get: function() {
              return this.tokens[this.position + 1];
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(Parser2.prototype, "prevToken", {
            get: function() {
              return this.tokens[this.position - 1];
            },
            enumerable: false,
            configurable: true
          });
          Parser2.prototype.locateNextMeaningfulToken = function(startPosition) {
            if (startPosition === void 0) {
              startPosition = this.position + 1;
            }
            var searchPosition = startPosition;
            while (searchPosition < this.tokens.length) {
              if (WHITESPACE_EQUIV_TOKENS[this.tokens[searchPosition][tokenize_1.FIELDS.TYPE]]) {
                searchPosition++;
                continue;
              } else {
                return searchPosition;
              }
            }
            return -1;
          };
          return Parser2;
        })()
      );
      exports.default = Parser;
    }
  });

  // node_modules/postcss-selector-parser/dist/processor.js
  var require_processor2 = __commonJS({
    "node_modules/postcss-selector-parser/dist/processor.js"(exports) {
      "use strict";
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      var parser_1 = __importDefault(require_parser2());
      var Processor2 = (
        /** @class */
        (function() {
          function Processor3(func, options) {
            this.func = func || function noop() {
            };
            this.funcRes = null;
            this.options = options;
          }
          Processor3.prototype._shouldUpdateSelector = function(rule2, options) {
            if (options === void 0) {
              options = {};
            }
            var merged = Object.assign({}, this.options, options);
            if (merged.updateSelector === false) {
              return false;
            } else {
              return typeof rule2 !== "string";
            }
          };
          Processor3.prototype._isLossy = function(options) {
            if (options === void 0) {
              options = {};
            }
            var merged = Object.assign({}, this.options, options);
            if (merged.lossless === false) {
              return true;
            } else {
              return false;
            }
          };
          Processor3.prototype._root = function(rule2, options) {
            if (options === void 0) {
              options = {};
            }
            var parser = new parser_1.default(rule2, this._parseOptions(options));
            return parser.root;
          };
          Processor3.prototype._parseOptions = function(options) {
            var merged = Object.assign({}, this.options, options);
            return {
              lossy: this._isLossy(merged),
              maxNestingDepth: merged.maxNestingDepth
            };
          };
          Processor3.prototype._stringifyOptions = function(options) {
            var merged = Object.assign({}, this.options, options);
            return {
              maxNestingDepth: merged.maxNestingDepth
            };
          };
          Processor3.prototype._run = function(rule2, options) {
            var _this = this;
            if (options === void 0) {
              options = {};
            }
            return new Promise(function(resolve, reject) {
              try {
                var root_1 = _this._root(rule2, options);
                Promise.resolve(_this.func(root_1)).then(function(transform) {
                  var string = void 0;
                  if (_this._shouldUpdateSelector(rule2, options)) {
                    string = root_1.toString(_this._stringifyOptions(options));
                    rule2.selector = string;
                  }
                  return { transform, root: root_1, string };
                }).then(resolve, reject);
              } catch (e4) {
                reject(e4);
                return;
              }
            });
          };
          Processor3.prototype._runSync = function(rule2, options) {
            if (options === void 0) {
              options = {};
            }
            var root2 = this._root(rule2, options);
            var transform = this.func(root2);
            if (transform && typeof transform.then === "function") {
              throw new Error("Selector processor returned a promise to a synchronous call.");
            }
            var string = void 0;
            if (options.updateSelector && typeof rule2 !== "string") {
              string = root2.toString(this._stringifyOptions(options));
              rule2.selector = string;
            }
            return { transform, root: root2, string };
          };
          Processor3.prototype.ast = function(rule2, options) {
            return this._run(rule2, options).then(function(result) {
              return result.root;
            });
          };
          Processor3.prototype.astSync = function(rule2, options) {
            return this._runSync(rule2, options).root;
          };
          Processor3.prototype.transform = function(rule2, options) {
            return this._run(rule2, options).then(function(result) {
              return result.transform;
            });
          };
          Processor3.prototype.transformSync = function(rule2, options) {
            return this._runSync(rule2, options).transform;
          };
          Processor3.prototype.process = function(rule2, options) {
            var _this = this;
            return this._run(rule2, options).then(function(result) {
              return result.string || result.root.toString(_this._stringifyOptions(options));
            });
          };
          Processor3.prototype.processSync = function(rule2, options) {
            var result = this._runSync(rule2, options);
            return result.string || result.root.toString(this._stringifyOptions(options));
          };
          return Processor3;
        })()
      );
      exports.default = Processor2;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/constructors.js
  var require_constructors = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/constructors.js"(exports) {
      "use strict";
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.universal = exports.tag = exports.string = exports.selector = exports.root = exports.pseudo = exports.nesting = exports.id = exports.comment = exports.combinator = exports.className = exports.attribute = void 0;
      var attribute_1 = __importDefault(require_attribute());
      var className_1 = __importDefault(require_className());
      var combinator_1 = __importDefault(require_combinator());
      var comment_1 = __importDefault(require_comment2());
      var id_1 = __importDefault(require_id());
      var nesting_1 = __importDefault(require_nesting());
      var pseudo_1 = __importDefault(require_pseudo());
      var root_1 = __importDefault(require_root2());
      var selector_1 = __importDefault(require_selector());
      var string_1 = __importDefault(require_string());
      var tag_1 = __importDefault(require_tag());
      var universal_1 = __importDefault(require_universal());
      var attribute = function(opts) {
        return new attribute_1.default(opts);
      };
      exports.attribute = attribute;
      var className = function(opts) {
        return new className_1.default(opts);
      };
      exports.className = className;
      var combinator = function(opts) {
        return new combinator_1.default(opts);
      };
      exports.combinator = combinator;
      var comment2 = function(opts) {
        return new comment_1.default(opts);
      };
      exports.comment = comment2;
      var id = function(opts) {
        return new id_1.default(opts);
      };
      exports.id = id;
      var nesting = function(opts) {
        return new nesting_1.default(opts);
      };
      exports.nesting = nesting;
      var pseudo = function(opts) {
        return new pseudo_1.default(opts);
      };
      exports.pseudo = pseudo;
      var root2 = function(opts) {
        return new root_1.default(opts);
      };
      exports.root = root2;
      var selector = function(opts) {
        return new selector_1.default(opts);
      };
      exports.selector = selector;
      var string = function(opts) {
        return new string_1.default(opts);
      };
      exports.string = string;
      var tag = function(opts) {
        return new tag_1.default(opts);
      };
      exports.tag = tag;
      var universal = function(opts) {
        return new universal_1.default(opts);
      };
      exports.universal = universal;
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/guards.js
  var require_guards = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/guards.js"(exports) {
      "use strict";
      var _a;
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.isUniversal = exports.isTag = exports.isString = exports.isSelector = exports.isRoot = exports.isPseudo = exports.isNesting = exports.isIdentifier = exports.isComment = exports.isCombinator = exports.isClassName = exports.isAttribute = void 0;
      exports.isNode = isNode;
      exports.isPseudoElement = isPseudoElement2;
      exports.isPseudoClass = isPseudoClass;
      exports.isContainer = isContainer;
      exports.isNamespace = isNamespace;
      var types_1 = require_types();
      var IS_TYPE = (_a = {}, _a[types_1.ATTRIBUTE] = true, _a[types_1.CLASS] = true, _a[types_1.COMBINATOR] = true, _a[types_1.COMMENT] = true, _a[types_1.ID] = true, _a[types_1.NESTING] = true, _a[types_1.PSEUDO] = true, _a[types_1.ROOT] = true, _a[types_1.SELECTOR] = true, _a[types_1.STRING] = true, _a[types_1.TAG] = true, _a[types_1.UNIVERSAL] = true, _a);
      function isNode(node) {
        return typeof node === "object" && IS_TYPE[node.type];
      }
      function isNodeType(type, node) {
        return isNode(node) && node.type === type;
      }
      exports.isAttribute = isNodeType.bind(null, types_1.ATTRIBUTE);
      exports.isClassName = isNodeType.bind(null, types_1.CLASS);
      exports.isCombinator = isNodeType.bind(null, types_1.COMBINATOR);
      exports.isComment = isNodeType.bind(null, types_1.COMMENT);
      exports.isIdentifier = isNodeType.bind(null, types_1.ID);
      exports.isNesting = isNodeType.bind(null, types_1.NESTING);
      exports.isPseudo = isNodeType.bind(null, types_1.PSEUDO);
      exports.isRoot = isNodeType.bind(null, types_1.ROOT);
      exports.isSelector = isNodeType.bind(null, types_1.SELECTOR);
      exports.isString = isNodeType.bind(null, types_1.STRING);
      exports.isTag = isNodeType.bind(null, types_1.TAG);
      exports.isUniversal = isNodeType.bind(null, types_1.UNIVERSAL);
      function isPseudoElement2(node) {
        return (0, exports.isPseudo)(node) && node.value && (node.value.startsWith("::") || node.value.toLowerCase() === ":before" || node.value.toLowerCase() === ":after" || node.value.toLowerCase() === ":first-letter" || node.value.toLowerCase() === ":first-line");
      }
      function isPseudoClass(node) {
        return (0, exports.isPseudo)(node) && !isPseudoElement2(node);
      }
      function isContainer(node) {
        return !!(isNode(node) && node.walk);
      }
      function isNamespace(node) {
        return (0, exports.isAttribute)(node) || (0, exports.isTag)(node);
      }
    }
  });

  // node_modules/postcss-selector-parser/dist/selectors/index.js
  var require_selectors = __commonJS({
    "node_modules/postcss-selector-parser/dist/selectors/index.js"(exports) {
      "use strict";
      var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        var desc = Object.getOwnPropertyDescriptor(m2, k2);
        if (!desc || ("get" in desc ? !m2.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m2[k2];
          } };
        }
        Object.defineProperty(o2, k22, desc);
      }) : (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        o2[k22] = m2[k2];
      }));
      var __exportStar = exports && exports.__exportStar || function(m2, exports2) {
        for (var p2 in m2) if (p2 !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p2)) __createBinding(exports2, m2, p2);
      };
      Object.defineProperty(exports, "__esModule", { value: true });
      __exportStar(require_types(), exports);
      __exportStar(require_constructors(), exports);
      __exportStar(require_guards(), exports);
    }
  });

  // node_modules/postcss-selector-parser/dist/index.js
  var require_dist = __commonJS({
    "node_modules/postcss-selector-parser/dist/index.js"(exports, module) {
      "use strict";
      var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        var desc = Object.getOwnPropertyDescriptor(m2, k2);
        if (!desc || ("get" in desc ? !m2.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m2[k2];
          } };
        }
        Object.defineProperty(o2, k22, desc);
      }) : (function(o2, m2, k2, k22) {
        if (k22 === void 0) k22 = k2;
        o2[k22] = m2[k2];
      }));
      var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o2, v2) {
        Object.defineProperty(o2, "default", { enumerable: true, value: v2 });
      }) : function(o2, v2) {
        o2["default"] = v2;
      });
      var __importStar = exports && exports.__importStar || /* @__PURE__ */ (function() {
        var ownKeys = function(o2) {
          ownKeys = Object.getOwnPropertyNames || function(o3) {
            var ar = [];
            for (var k2 in o3) if (Object.prototype.hasOwnProperty.call(o3, k2)) ar[ar.length] = k2;
            return ar;
          };
          return ownKeys(o2);
        };
        return function(mod) {
          if (mod && mod.__esModule) return mod;
          var result = {};
          if (mod != null) {
            for (var k2 = ownKeys(mod), i2 = 0; i2 < k2.length; i2++) if (k2[i2] !== "default") __createBinding(result, mod, k2[i2]);
          }
          __setModuleDefault(result, mod);
          return result;
        };
      })();
      var __importDefault = exports && exports.__importDefault || function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      var processor_1 = __importDefault(require_processor2());
      var selectors = __importStar(require_selectors());
      var parser = function(processor) {
        return new processor_1.default(processor);
      };
      Object.assign(parser, selectors);
      delete parser.__esModule;
      module.exports = parser;
    }
  });

  // node_modules/postcss-value-parser/lib/parse.js
  var require_parse2 = __commonJS({
    "node_modules/postcss-value-parser/lib/parse.js"(exports, module) {
      var openParentheses = "(".charCodeAt(0);
      var closeParentheses = ")".charCodeAt(0);
      var singleQuote = "'".charCodeAt(0);
      var doubleQuote = '"'.charCodeAt(0);
      var backslash = "\\".charCodeAt(0);
      var slash = "/".charCodeAt(0);
      var comma = ",".charCodeAt(0);
      var colon = ":".charCodeAt(0);
      var star = "*".charCodeAt(0);
      var uLower = "u".charCodeAt(0);
      var uUpper = "U".charCodeAt(0);
      var plus = "+".charCodeAt(0);
      var isUnicodeRange = /^[a-f0-9?-]+$/i;
      module.exports = function(input) {
        var tokens = [];
        var value = input;
        var next, quote, prev, token, escape, escapePos, whitespacePos, parenthesesOpenPos;
        var pos = 0;
        var code = value.charCodeAt(pos);
        var max = value.length;
        var stack = [{ nodes: tokens }];
        var balanced = 0;
        var parent;
        var name = "";
        var before = "";
        var after = "";
        while (pos < max) {
          if (code <= 32) {
            next = pos;
            do {
              next += 1;
              code = value.charCodeAt(next);
            } while (code <= 32);
            token = value.slice(pos, next);
            prev = tokens[tokens.length - 1];
            if (code === closeParentheses && balanced) {
              after = token;
            } else if (prev && prev.type === "div") {
              prev.after = token;
              prev.sourceEndIndex += token.length;
            } else if (code === comma || code === colon || code === slash && value.charCodeAt(next + 1) !== star && (!parent || parent && parent.type === "function" && parent.value !== "calc")) {
              before = token;
            } else {
              tokens.push({
                type: "space",
                sourceIndex: pos,
                sourceEndIndex: next,
                value: token
              });
            }
            pos = next;
          } else if (code === singleQuote || code === doubleQuote) {
            next = pos;
            quote = code === singleQuote ? "'" : '"';
            token = {
              type: "string",
              sourceIndex: pos,
              quote
            };
            do {
              escape = false;
              next = value.indexOf(quote, next + 1);
              if (~next) {
                escapePos = next;
                while (value.charCodeAt(escapePos - 1) === backslash) {
                  escapePos -= 1;
                  escape = !escape;
                }
              } else {
                value += quote;
                next = value.length - 1;
                token.unclosed = true;
              }
            } while (escape);
            token.value = value.slice(pos + 1, next);
            token.sourceEndIndex = token.unclosed ? next : next + 1;
            tokens.push(token);
            pos = next + 1;
            code = value.charCodeAt(pos);
          } else if (code === slash && value.charCodeAt(pos + 1) === star) {
            next = value.indexOf("*/", pos);
            token = {
              type: "comment",
              sourceIndex: pos,
              sourceEndIndex: next + 2
            };
            if (next === -1) {
              token.unclosed = true;
              next = value.length;
              token.sourceEndIndex = next;
            }
            token.value = value.slice(pos + 2, next);
            tokens.push(token);
            pos = next + 2;
            code = value.charCodeAt(pos);
          } else if ((code === slash || code === star) && parent && parent.type === "function" && parent.value === "calc") {
            token = value[pos];
            tokens.push({
              type: "word",
              sourceIndex: pos - before.length,
              sourceEndIndex: pos + token.length,
              value: token
            });
            pos += 1;
            code = value.charCodeAt(pos);
          } else if (code === slash || code === comma || code === colon) {
            token = value[pos];
            tokens.push({
              type: "div",
              sourceIndex: pos - before.length,
              sourceEndIndex: pos + token.length,
              value: token,
              before,
              after: ""
            });
            before = "";
            pos += 1;
            code = value.charCodeAt(pos);
          } else if (openParentheses === code) {
            next = pos;
            do {
              next += 1;
              code = value.charCodeAt(next);
            } while (code <= 32);
            parenthesesOpenPos = pos;
            token = {
              type: "function",
              sourceIndex: pos - name.length,
              value: name,
              before: value.slice(parenthesesOpenPos + 1, next)
            };
            pos = next;
            if (name === "url" && code !== singleQuote && code !== doubleQuote) {
              next -= 1;
              do {
                escape = false;
                next = value.indexOf(")", next + 1);
                if (~next) {
                  escapePos = next;
                  while (value.charCodeAt(escapePos - 1) === backslash) {
                    escapePos -= 1;
                    escape = !escape;
                  }
                } else {
                  value += ")";
                  next = value.length - 1;
                  token.unclosed = true;
                }
              } while (escape);
              whitespacePos = next;
              do {
                whitespacePos -= 1;
                code = value.charCodeAt(whitespacePos);
              } while (code <= 32);
              if (parenthesesOpenPos < whitespacePos) {
                if (pos !== whitespacePos + 1) {
                  token.nodes = [
                    {
                      type: "word",
                      sourceIndex: pos,
                      sourceEndIndex: whitespacePos + 1,
                      value: value.slice(pos, whitespacePos + 1)
                    }
                  ];
                } else {
                  token.nodes = [];
                }
                if (token.unclosed && whitespacePos + 1 !== next) {
                  token.after = "";
                  token.nodes.push({
                    type: "space",
                    sourceIndex: whitespacePos + 1,
                    sourceEndIndex: next,
                    value: value.slice(whitespacePos + 1, next)
                  });
                } else {
                  token.after = value.slice(whitespacePos + 1, next);
                  token.sourceEndIndex = next;
                }
              } else {
                token.after = "";
                token.nodes = [];
              }
              pos = next + 1;
              token.sourceEndIndex = token.unclosed ? next : pos;
              code = value.charCodeAt(pos);
              tokens.push(token);
            } else {
              balanced += 1;
              token.after = "";
              token.sourceEndIndex = pos + 1;
              tokens.push(token);
              stack.push(token);
              tokens = token.nodes = [];
              parent = token;
            }
            name = "";
          } else if (closeParentheses === code && balanced) {
            pos += 1;
            code = value.charCodeAt(pos);
            parent.after = after;
            parent.sourceEndIndex += after.length;
            after = "";
            balanced -= 1;
            stack[stack.length - 1].sourceEndIndex = pos;
            stack.pop();
            parent = stack[balanced];
            tokens = parent.nodes;
          } else {
            next = pos;
            do {
              if (code === backslash) {
                next += 1;
              }
              next += 1;
              code = value.charCodeAt(next);
            } while (next < max && !(code <= 32 || code === singleQuote || code === doubleQuote || code === comma || code === colon || code === slash || code === openParentheses || code === star && parent && parent.type === "function" && parent.value === "calc" || code === slash && parent.type === "function" && parent.value === "calc" || code === closeParentheses && balanced));
            token = value.slice(pos, next);
            if (openParentheses === code) {
              name = token;
            } else if ((uLower === token.charCodeAt(0) || uUpper === token.charCodeAt(0)) && plus === token.charCodeAt(1) && isUnicodeRange.test(token.slice(2))) {
              tokens.push({
                type: "unicode-range",
                sourceIndex: pos,
                sourceEndIndex: next,
                value: token
              });
            } else {
              tokens.push({
                type: "word",
                sourceIndex: pos,
                sourceEndIndex: next,
                value: token
              });
            }
            pos = next;
          }
        }
        for (pos = stack.length - 1; pos; pos -= 1) {
          stack[pos].unclosed = true;
          stack[pos].sourceEndIndex = value.length;
        }
        return stack[0].nodes;
      };
    }
  });

  // node_modules/postcss-value-parser/lib/walk.js
  var require_walk = __commonJS({
    "node_modules/postcss-value-parser/lib/walk.js"(exports, module) {
      module.exports = function walk(nodes, cb, bubble) {
        var i2, max, node, result;
        for (i2 = 0, max = nodes.length; i2 < max; i2 += 1) {
          node = nodes[i2];
          if (!bubble) {
            result = cb(node, i2, nodes);
          }
          if (result !== false && node.type === "function" && Array.isArray(node.nodes)) {
            walk(node.nodes, cb, bubble);
          }
          if (bubble) {
            cb(node, i2, nodes);
          }
        }
      };
    }
  });

  // node_modules/postcss-value-parser/lib/stringify.js
  var require_stringify2 = __commonJS({
    "node_modules/postcss-value-parser/lib/stringify.js"(exports, module) {
      function stringifyNode(node, custom) {
        var type = node.type;
        var value = node.value;
        var buf;
        var customResult;
        if (custom && (customResult = custom(node)) !== void 0) {
          return customResult;
        } else if (type === "word" || type === "space") {
          return value;
        } else if (type === "string") {
          buf = node.quote || "";
          return buf + value + (node.unclosed ? "" : buf);
        } else if (type === "comment") {
          return "/*" + value + (node.unclosed ? "" : "*/");
        } else if (type === "div") {
          return (node.before || "") + value + (node.after || "");
        } else if (Array.isArray(node.nodes)) {
          buf = stringify2(node.nodes, custom);
          if (type !== "function") {
            return buf;
          }
          return value + "(" + (node.before || "") + buf + (node.after || "") + (node.unclosed ? "" : ")");
        }
        return value;
      }
      function stringify2(nodes, custom) {
        var result, i2;
        if (Array.isArray(nodes)) {
          result = "";
          for (i2 = nodes.length - 1; ~i2; i2 -= 1) {
            result = stringifyNode(nodes[i2], custom) + result;
          }
          return result;
        }
        return stringifyNode(nodes, custom);
      }
      module.exports = stringify2;
    }
  });

  // node_modules/postcss-value-parser/lib/unit.js
  var require_unit = __commonJS({
    "node_modules/postcss-value-parser/lib/unit.js"(exports, module) {
      var minus = "-".charCodeAt(0);
      var plus = "+".charCodeAt(0);
      var dot = ".".charCodeAt(0);
      var exp = "e".charCodeAt(0);
      var EXP = "E".charCodeAt(0);
      function likeNumber(value) {
        var code = value.charCodeAt(0);
        var nextCode;
        if (code === plus || code === minus) {
          nextCode = value.charCodeAt(1);
          if (nextCode >= 48 && nextCode <= 57) {
            return true;
          }
          var nextNextCode = value.charCodeAt(2);
          if (nextCode === dot && nextNextCode >= 48 && nextNextCode <= 57) {
            return true;
          }
          return false;
        }
        if (code === dot) {
          nextCode = value.charCodeAt(1);
          if (nextCode >= 48 && nextCode <= 57) {
            return true;
          }
          return false;
        }
        if (code >= 48 && code <= 57) {
          return true;
        }
        return false;
      }
      module.exports = function(value) {
        var pos = 0;
        var length = value.length;
        var code;
        var nextCode;
        var nextNextCode;
        if (length === 0 || !likeNumber(value)) {
          return false;
        }
        code = value.charCodeAt(pos);
        if (code === plus || code === minus) {
          pos++;
        }
        while (pos < length) {
          code = value.charCodeAt(pos);
          if (code < 48 || code > 57) {
            break;
          }
          pos += 1;
        }
        code = value.charCodeAt(pos);
        nextCode = value.charCodeAt(pos + 1);
        if (code === dot && nextCode >= 48 && nextCode <= 57) {
          pos += 2;
          while (pos < length) {
            code = value.charCodeAt(pos);
            if (code < 48 || code > 57) {
              break;
            }
            pos += 1;
          }
        }
        code = value.charCodeAt(pos);
        nextCode = value.charCodeAt(pos + 1);
        nextNextCode = value.charCodeAt(pos + 2);
        if ((code === exp || code === EXP) && (nextCode >= 48 && nextCode <= 57 || (nextCode === plus || nextCode === minus) && nextNextCode >= 48 && nextNextCode <= 57)) {
          pos += nextCode === plus || nextCode === minus ? 3 : 2;
          while (pos < length) {
            code = value.charCodeAt(pos);
            if (code < 48 || code > 57) {
              break;
            }
            pos += 1;
          }
        }
        return {
          number: value.slice(0, pos),
          unit: value.slice(pos)
        };
      };
    }
  });

  // node_modules/postcss-value-parser/lib/index.js
  var require_lib = __commonJS({
    "node_modules/postcss-value-parser/lib/index.js"(exports, module) {
      var parse2 = require_parse2();
      var walk = require_walk();
      var stringify2 = require_stringify2();
      function ValueParser(value) {
        if (this instanceof ValueParser) {
          this.nodes = parse2(value);
          return this;
        }
        return new ValueParser(value);
      }
      ValueParser.prototype.toString = function() {
        return Array.isArray(this.nodes) ? stringify2(this.nodes) : "";
      };
      ValueParser.prototype.walk = function(cb, bubble) {
        walk(this.nodes, cb, bubble);
        return this;
      };
      ValueParser.unit = require_unit();
      ValueParser.walk = walk;
      ValueParser.stringify = stringify2;
      module.exports = ValueParser;
    }
  });

  // node_modules/postcss/lib/postcss.mjs
  var import_postcss = __toESM(require_postcss(), 1);
  var postcss_default = import_postcss.default;
  var stringify = import_postcss.default.stringify;
  var fromJSON = import_postcss.default.fromJSON;
  var plugin = import_postcss.default.plugin;
  var parse = import_postcss.default.parse;
  var list = import_postcss.default.list;
  var document2 = import_postcss.default.document;
  var comment = import_postcss.default.comment;
  var atRule = import_postcss.default.atRule;
  var rule = import_postcss.default.rule;
  var decl = import_postcss.default.decl;
  var root = import_postcss.default.root;
  var CssSyntaxError = import_postcss.default.CssSyntaxError;
  var Declaration = import_postcss.default.Declaration;
  var Container = import_postcss.default.Container;
  var Processor = import_postcss.default.Processor;
  var Document = import_postcss.default.Document;
  var Comment = import_postcss.default.Comment;
  var Warning = import_postcss.default.Warning;
  var AtRule = import_postcss.default.AtRule;
  var Result = import_postcss.default.Result;
  var Input = import_postcss.default.Input;
  var Rule = import_postcss.default.Rule;
  var Root = import_postcss.default.Root;
  var Node2 = import_postcss.default.Node;

  // src/main/modules/userscripts/bundled-scripts/css-fixer-core.ts
  var import_postcss_selector_parser3 = __toESM(require_dist());
  var import_postcss_value_parser3 = __toESM(require_lib());

  // node_modules/css-has-pseudo/dist/index.mjs
  var import_postcss_selector_parser2 = __toESM(require_dist(), 1);
  var import_postcss_value_parser = __toESM(require_lib(), 1);

  // node_modules/@csstools/selector-specificity/dist/index.mjs
  var import_postcss_selector_parser = __toESM(require_dist(), 1);
  function compare(e4, t3) {
    return e4.a === t3.a ? e4.b === t3.b ? e4.c - t3.c : e4.b - t3.b : e4.a - t3.a;
  }
  function selectorSpecificity(t3, s2) {
    var _a, _b;
    const i2 = (_a = s2 == null ? void 0 : s2.customSpecificity) == null ? void 0 : _a.call(s2, t3);
    if (i2) return i2;
    if (!t3) return { a: 0, b: 0, c: 0 };
    let c2 = 0, n2 = 0, o2 = 0;
    if ("universal" == t3.type) return { a: 0, b: 0, c: 0 };
    if ("id" === t3.type) c2 += 1;
    else if ("tag" === t3.type) o2 += 1;
    else if ("class" === t3.type) n2 += 1;
    else if ("attribute" === t3.type) n2 += 1;
    else if (isPseudoElement(t3)) switch (t3.value.toLowerCase()) {
      case "::slotted":
        if (o2 += 1, t3.nodes && t3.nodes.length > 0) {
          const e4 = specificityOfMostSpecificListItem(t3.nodes, s2);
          c2 += e4.a, n2 += e4.b, o2 += e4.c;
        }
        break;
      case "::view-transition-group":
      case "::view-transition-image-pair":
      case "::view-transition-old":
      case "::view-transition-new":
        return t3.nodes && 1 === t3.nodes.length && "selector" === t3.nodes[0].type && selectorNodeContainsNothingOrOnlyUniversal(t3.nodes[0]) ? { a: 0, b: 0, c: 0 } : { a: 0, b: 0, c: 1 };
      default:
        o2 += 1;
    }
    else if (import_postcss_selector_parser.default.isPseudoClass(t3)) switch (t3.value.toLowerCase()) {
      case ":-webkit-any":
      case ":any":
      default:
        n2 += 1;
        break;
      case ":-moz-any":
      case ":has":
      case ":is":
      case ":matches":
      case ":not":
        if (t3.nodes && t3.nodes.length > 0) {
          const e4 = specificityOfMostSpecificListItem(t3.nodes, s2);
          c2 += e4.a, n2 += e4.b, o2 += e4.c;
        }
        break;
      case ":where":
        break;
      case ":nth-child":
      case ":nth-last-child":
        if (n2 += 1, t3.nodes && t3.nodes.length > 0) {
          const i3 = t3.nodes[0].nodes.findIndex((e4) => "tag" === e4.type && "of" === e4.value.toLowerCase());
          if (i3 > -1) {
            const a2 = import_postcss_selector_parser.default.selector({ nodes: [], value: "" });
            t3.nodes[0].nodes.slice(i3 + 1).forEach((e4) => {
              a2.append(e4.clone());
            });
            const r2 = [a2];
            t3.nodes.length > 1 && r2.push(...t3.nodes.slice(1));
            const l2 = specificityOfMostSpecificListItem(r2, s2);
            c2 += l2.a, n2 += l2.b, o2 += l2.c;
          }
        }
        break;
      case ":local":
      case ":global":
        t3.nodes && t3.nodes.length > 0 && t3.nodes.forEach((e4) => {
          const t4 = selectorSpecificity(e4, s2);
          c2 += t4.a, n2 += t4.b, o2 += t4.c;
        });
        break;
      case ":host":
      case ":host-context":
        if (n2 += 1, t3.nodes && t3.nodes.length > 0) {
          const e4 = specificityOfMostSpecificListItem(t3.nodes, s2);
          c2 += e4.a, n2 += e4.b, o2 += e4.c;
        }
        break;
      case ":active-view-transition":
      case ":active-view-transition-type":
        return { a: 0, b: 1, c: 0 };
    }
    else import_postcss_selector_parser.default.isContainer(t3) && ((_b = t3.nodes) == null ? void 0 : _b.length) > 0 && t3.nodes.forEach((e4) => {
      const t4 = selectorSpecificity(e4, s2);
      c2 += t4.a, n2 += t4.b, o2 += t4.c;
    });
    return { a: c2, b: n2, c: o2 };
  }
  function specificityOfMostSpecificListItem(e4, t3) {
    let s2 = { a: 0, b: 0, c: 0 };
    return e4.forEach((e5) => {
      const i2 = selectorSpecificity(e5, t3);
      compare(i2, s2) < 0 || (s2 = i2);
    }), s2;
  }
  function isPseudoElement(t3) {
    return import_postcss_selector_parser.default.isPseudoElement(t3);
  }
  function selectorNodeContainsNothingOrOnlyUniversal(e4) {
    if (!e4) return false;
    if (!e4.nodes) return false;
    const t3 = e4.nodes.filter((e5) => "comment" !== e5.type);
    return 0 === t3.length || 1 === t3.length && "universal" === t3[0].type;
  }

  // node_modules/css-has-pseudo/dist/index.mjs
  function encodeCSS(e4) {
    if ("" === e4) return "";
    for (var t3, s2 = "", o2 = 0; o2 < e4.length; o2++) t3 = e4.charCodeAt(o2).toString(36), s2 += 0 === o2 ? t3 : "-" + t3;
    return "csstools-has-" + s2;
  }
  function isGuardedByAtSupportsFromAtRuleParams(e4) {
    if (!e4.toLowerCase().includes(":has(")) return false;
    let s2 = false;
    try {
      const o2 = /* @__PURE__ */ new Set();
      (0, import_postcss_value_parser.default)(e4).walk((e5) => {
        if ("function" === e5.type && "selector" === e5.value.toLowerCase()) return o2.add(import_postcss_value_parser.default.stringify(e5.nodes)), false;
      }), o2.forEach((e5) => {
        selectorContainsHasPseudo(e5) && (s2 = true);
      });
    } catch {
    }
    return s2;
  }
  function selectorContainsHasPseudo(t3) {
    if (!t3.toLowerCase().includes(":has(")) return false;
    let s2 = false;
    try {
      (0, import_postcss_selector_parser2.default)().astSync(t3).walk((e4) => {
        if ("pseudo" === e4.type && ":has" === e4.value.toLowerCase() && e4.nodes && e4.nodes.length > 0) return s2 = true, false;
      });
    } catch {
    }
    return s2;
  }
  var creator = (t3) => {
    const o2 = { preserve: true, specificityMatchingName: "does-not-exist", ...t3 || {} }, r2 = ":not(#" + o2.specificityMatchingName + ")", n2 = ":not(." + o2.specificityMatchingName + ")", a2 = ":not(" + o2.specificityMatchingName + ")";
    return { postcssPlugin: "css-has-pseudo", prepare() {
      const t4 = /* @__PURE__ */ new WeakSet();
      return { postcssPlugin: "css-has-pseudo", RuleExit(c2, { result: i2 }) {
        if (t4.has(c2)) return;
        if (!c2.selector.toLowerCase().includes(":has(") || isWithinSupportCheck(c2)) return;
        const l2 = c2.selectors.map((t5) => {
          if (!t5.toLowerCase().includes(":has(")) return t5;
          let l3;
          try {
            l3 = (0, import_postcss_selector_parser2.default)().astSync(t5);
          } catch (e4) {
            return c2.warn(i2, `Failed to parse selector : "${t5}" with message: "${e4 instanceof Error ? e4.message : e4}"`), t5;
          }
          if (void 0 === l3) return t5;
          l3.walkPseudos((t6) => {
            let s2 = t6.parent, r3 = false;
            for (; s2; ) import_postcss_selector_parser2.default.isPseudoClass(s2) && ":has" === s2.value.toLowerCase() && (r3 = true), s2 = s2.parent;
            r3 && (":visited" === t6.value.toLowerCase() && t6.replaceWith(import_postcss_selector_parser2.default.className({ value: o2.specificityMatchingName })), ":any-link" === t6.value.toLowerCase() && (t6.value = ":link"));
          }), l3.walkPseudos((t6) => {
            if (":has" !== t6.value.toLowerCase() || !t6.nodes) return;
            const o3 = t6.parent;
            if (!o3) return;
            const c3 = import_postcss_selector_parser2.default.selector({ value: "", nodes: [] });
            {
              let t7 = o3.nodes.length;
              e: for (let s2 = 0; s2 < o3.nodes.length; s2++) {
                const r3 = o3.nodes[s2];
                if (import_postcss_selector_parser2.default.isPseudoElement(r3)) {
                  for (let e4 = s2 - 1; e4 >= 0; e4--) if ("combinator" !== o3.nodes[s2].type && "comment" !== o3.nodes[s2].type) {
                    t7 = e4 + 1;
                    break e;
                  }
                }
              }
              o3.nodes.slice(0, t7).forEach((e4) => {
                e4.remove(), "selector" === e4.type ? e4.nodes.forEach((e5) => {
                  delete e5.parent, c3.append(e5);
                }) : (delete e4.parent, c3.append(e4));
              });
            }
            const i3 = "[" + encodeCSS(c3.toString()) + "]", l4 = selectorSpecificity(c3);
            let u3 = i3;
            for (let e4 = 0; e4 < l4.a; e4++) u3 += r2;
            const p2 = Math.max(1, l4.b) - 1;
            for (let e4 = 0; e4 < p2; e4++) u3 += n2;
            for (let e4 = 0; e4 < l4.c; e4++) u3 += a2;
            const d2 = (0, import_postcss_selector_parser2.default)().astSync(u3).nodes[0].nodes;
            for (let e4 = d2.length - 1; e4 >= 0; e4--) o3.prepend(d2[e4]);
          });
          const u2 = l3.toString();
          return u2 !== t5 ? ".js-has-pseudo " + u2 : t5;
        });
        l2.join(",") !== c2.selectors.join(",") && (t4.add(c2), c2.cloneBefore({ selectors: l2 }), o2.preserve || c2.remove());
      } };
    } };
  };
  function isWithinSupportCheck(e4) {
    let t3 = e4.parent;
    for (; t3; ) {
      if ("atrule" === t3.type && isGuardedByAtSupportsFromAtRuleParams(t3.params)) return true;
      t3 = t3.parent;
    }
    return false;
  }
  creator.postcss = true;

  // src/main/modules/userscripts/bundled-scripts/css-fixer-color.ts
  var import_postcss_value_parser2 = __toESM(require_lib());
  var MODERN_COLOR_RE = /\b(oklch|oklab|lch|lab|hwb|color-mix|color)\(/i;
  var CONVERTIBLE_FUNCS = /* @__PURE__ */ new Set(["oklch", "oklab", "lch", "lab", "hwb", "color", "color-mix"]);
  function needsColorRewrite(value) {
    return MODERN_COLOR_RE.test(value);
  }
  var D65 = { X: 0.95047, Y: 1, Z: 1.08883 };
  var XYZ_TO_SRGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252]
  ];
  var SRGB_TO_XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041]
  ];
  function srgbToLinear(c2) {
    return c2 <= 0.04045 ? c2 / 12.92 : Math.pow((c2 + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c2) {
    return c2 <= 31308e-7 ? 12.92 * c2 : 1.055 * Math.pow(c2, 1 / 2.4) - 0.055;
  }
  function xyzToLab(x2, y2, z2) {
    const f2 = (t3) => t3 > 8856e-6 ? Math.cbrt(t3) : 7.787 * t3 + 16 / 116;
    const fx = f2(x2 / D65.X);
    const fy = f2(y2);
    const fz = f2(z2 / D65.Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToXyz(l2, a2, b2) {
    const fInv = (t3) => {
      const t32 = t3 * t3 * t3;
      return t32 > 8856e-6 ? t32 : (t3 - 16 / 116) / 7.787;
    };
    const fy = (l2 + 16) / 116;
    const fx = fy + a2 / 500;
    const fz = fy - b2 / 200;
    return [fInv(fx) * D65.X, fInv(fy), fInv(fz) * D65.Z];
  }
  function oklabToLab(L2, a2, b2) {
    const lr = L2 + 0.3963377774 * a2 + 0.2158037573 * b2;
    const mr = L2 - 0.1055613458 * a2 - 0.0638541728 * b2;
    const sr = L2 - 0.0894841775 * a2 - 1.291485548 * b2;
    const l2 = lr * lr * lr;
    const m2 = mr * mr * mr;
    const s2 = sr * sr * sr;
    const x2 = 1.2270138511 * l2 - 0.5577999807 * m2 + 0.281256149 * s2;
    const y2 = -0.0405801784 * l2 + 1.1122568696 * m2 - 0.0716766787 * s2;
    const z2 = -0.0763812845 * l2 - 0.4214819784 * m2 + 1.5861632204 * s2;
    return xyzToLab(x2, y2, z2);
  }
  function oklabToXyz(L2, a2, b2) {
    const [l2, aa, bb] = oklabToLab(L2, a2, b2);
    return labToXyz(l2, aa, bb);
  }
  function xyzToSrgb(x2, y2, z2) {
    const r2 = XYZ_TO_SRGB[0][0] * x2 + XYZ_TO_SRGB[0][1] * y2 + XYZ_TO_SRGB[0][2] * z2;
    const g2 = XYZ_TO_SRGB[1][0] * x2 + XYZ_TO_SRGB[1][1] * y2 + XYZ_TO_SRGB[1][2] * z2;
    const b2 = XYZ_TO_SRGB[2][0] * x2 + XYZ_TO_SRGB[2][1] * y2 + XYZ_TO_SRGB[2][2] * z2;
    return [linearToSrgb(r2), linearToSrgb(g2), linearToSrgb(b2)];
  }
  function srgbToXyz(r2, g2, b2) {
    const rl = srgbToLinear(r2);
    const gl = srgbToLinear(g2);
    const bl = srgbToLinear(b2);
    return [
      SRGB_TO_XYZ[0][0] * rl + SRGB_TO_XYZ[0][1] * gl + SRGB_TO_XYZ[0][2] * bl,
      SRGB_TO_XYZ[1][0] * rl + SRGB_TO_XYZ[1][1] * gl + SRGB_TO_XYZ[1][2] * bl,
      SRGB_TO_XYZ[2][0] * rl + SRGB_TO_XYZ[2][1] * gl + SRGB_TO_XYZ[2][2] * bl
    ];
  }
  function srgbToOklab(r2, g2, b2) {
    const [x2, y2, z2] = srgbToXyz(r2, g2, b2);
    const lr = Math.cbrt(x2 / D65.X);
    const mr = Math.cbrt(y2);
    const sr = Math.cbrt(z2 / D65.Z);
    return [
      0.2104542553 * lr + 0.793617785 * mr - 0.0040720468 * sr,
      1.9779984951 * lr - 2.428592205 * mr + 0.4505937099 * sr,
      0.0259040371 * lr + 0.7827717662 * mr - 0.808675766 * sr
    ];
  }
  function oklabToSrgb(L2, a2, b2) {
    const [x2, y2, z2] = oklabToXyz(L2, a2, b2);
    return xyzToSrgb(x2, y2, z2);
  }
  function hslPure(hue) {
    const h2 = (hue % 360 + 360) % 360;
    const i2 = Math.floor(h2 / 60) % 6;
    const f2 = h2 / 60 % 2;
    const x2 = 1 - Math.abs(f2 - 1);
    switch (i2) {
      case 0:
        return [1, x2, 0];
      case 1:
        return [x2, 1, 0];
      case 2:
        return [0, 1, x2];
      case 3:
        return [0, x2, 1];
      case 4:
        return [x2, 0, 1];
      default:
        return [1, 0, x2];
    }
  }
  var clamp01 = (v2) => Math.min(1, Math.max(0, v2));
  var NAMED_COLORS = {
    black: [0, 0, 0],
    silver: [192, 192, 192],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    white: [255, 255, 255],
    maroon: [128, 0, 0],
    red: [255, 0, 0],
    purple: [128, 0, 128],
    fuchsia: [255, 0, 255],
    green: [0, 128, 0],
    lime: [0, 255, 0],
    olive: [128, 128, 0],
    yellow: [255, 255, 0],
    navy: [0, 0, 128],
    blue: [0, 0, 255],
    teal: [0, 128, 128],
    aqua: [0, 255, 255],
    orange: [255, 165, 0],
    pink: [255, 192, 203],
    brown: [165, 42, 42],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    limegreen: [50, 205, 50],
    lightgray: [211, 211, 211],
    lightgrey: [211, 211, 211],
    darkgray: [169, 169, 169],
    darkgrey: [169, 169, 169],
    darkred: [139, 0, 0],
    darkgreen: [0, 100, 0],
    darkblue: [0, 0, 139],
    darkorange: [255, 140, 0],
    gold: [255, 215, 0],
    skyblue: [135, 206, 235],
    violet: [238, 130, 238],
    tan: [210, 180, 140],
    beige: [245, 245, 220]
  };
  function hexToRgb(hex) {
    const h2 = hex.replace(/^#/, "");
    if (!/^[0-9a-fA-F]+$/.test(h2)) return null;
    if (h2.length === 3 || h2.length === 4) {
      const r2 = parseInt(h2[0] + h2[0], 16);
      const g2 = parseInt(h2[1] + h2[1], 16);
      const b2 = parseInt(h2[2] + h2[2], 16);
      return [r2 / 255, g2 / 255, b2 / 255];
    }
    if (h2.length === 6 || h2.length === 8) {
      const r2 = parseInt(h2.slice(0, 2), 16);
      const g2 = parseInt(h2.slice(2, 4), 16);
      const b2 = parseInt(h2.slice(4, 6), 16);
      return [r2 / 255, g2 / 255, b2 / 255];
    }
    return null;
  }
  function resolveColorNode(node) {
    if (node.type === "word") {
      const w2 = node.value;
      if (w2.startsWith("#")) return hexToRgb(w2);
      const named = NAMED_COLORS[w2.toLowerCase()];
      if (named) return [named[0] / 255, named[1] / 255, named[2] / 255];
      return null;
    }
    if (node.type === "function") {
      const name = node.value.toLowerCase();
      if (name === "rgb" || name === "rgba") {
        const comps = parseComponents(node);
        if (!comps) return null;
        const rgb = [comps.args[0] / 255, comps.args[1] / 255, comps.args[2] / 255];
        return rgb;
      }
      if (name === "hsl" || name === "hsla") {
        const comps = parseComponents(node);
        if (!comps) return null;
        const [h2, s2, l2] = comps.args;
        const pure = hslPure(h2);
        const c2 = (1 - Math.abs(2 * l2 - 1)) * s2;
        const m2 = l2 - c2 / 2;
        return [pure[0] * c2 + m2, pure[1] * c2 + m2, pure[2] * c2 + m2];
      }
      if (CONVERTIBLE_FUNCS.has(name)) {
        const out = convertFunction(node);
        if (!out) return null;
        return parseRgbToNumbers(out);
      }
    }
    return null;
  }
  function parseComponents(fn) {
    const values = [];
    let alpha = null;
    let sawSlash = false;
    for (const node of fn.nodes) {
      if (node.type === "space") continue;
      if (node.type === "div" && node.value === "/") {
        sawSlash = true;
        continue;
      }
      if (node.type !== "word") return null;
      const word = node.value.toLowerCase();
      if (sawSlash) {
        if (word === "none") continue;
        if (word.endsWith("%")) alpha = parseFloat(word) / 100;
        else alpha = parseFloat(word);
        if (Number.isNaN(alpha)) return null;
        continue;
      }
      if (word === "none") {
        values.push(0);
        continue;
      }
      const n2 = parseFloat(word);
      if (Number.isNaN(n2)) return null;
      values.push(n2);
    }
    if (values.length < 3 || values.length > 4) return null;
    if (values.length === 4 && alpha === null) {
      alpha = values[3];
      values.pop();
    }
    return { args: values, alpha };
  }
  function convertHwb(args) {
    const [h2, w2, b2] = args;
    if (w2 + b2 >= 1) {
      const gray = w2 / (w2 + b2);
      return [gray, gray, gray];
    }
    const pure = hslPure(h2);
    const f2 = 1 - w2 - b2;
    return [pure[0] * f2 + w2, pure[1] * f2 + w2, pure[2] * f2 + w2];
  }
  function convertOklab(args) {
    const L2 = args[0] > 1 && args[0] <= 100 ? args[0] / 100 : args[0];
    const a2 = args[1];
    const b2 = args[2];
    if (L2 < 0 || L2 > 1) return null;
    return oklabToSrgb(L2, a2, b2);
  }
  function convertOklch(args) {
    const L2 = args[0] > 1 && args[0] <= 100 ? args[0] / 100 : args[0];
    const c2 = args[1] > 1 ? args[1] / 100 : args[1];
    const h2 = args[2];
    if (L2 < 0 || L2 > 1) return null;
    const a2 = c2 * Math.cos(h2 * Math.PI / 180);
    const b2 = c2 * Math.sin(h2 * Math.PI / 180);
    return oklabToSrgb(L2, a2, b2);
  }
  function convertLab(args) {
    const l2 = args[0] <= 100 && args[0] >= 0 ? args[0] : null;
    if (l2 === null) return null;
    const a2 = args[1];
    const b2 = args[2];
    const [x2, y2, z2] = labToXyz(l2, a2, b2);
    return xyzToSrgb(x2, y2, z2);
  }
  function convertLch(args) {
    const l2 = args[0] <= 100 && args[0] >= 0 ? args[0] : null;
    if (l2 === null) return null;
    const c2 = args[1];
    const h2 = args[2];
    const a2 = c2 * Math.cos(h2 * Math.PI / 180);
    const b2 = c2 * Math.sin(h2 * Math.PI / 180);
    const [x2, y2, z2] = labToXyz(l2, a2, b2);
    return xyzToSrgb(x2, y2, z2);
  }
  function convertColorFn(args, space) {
    const name = space.toLowerCase();
    if (name === "srgb" || name === "srgb-linear") {
      if (name === "srgb-linear") return args.map((c2) => linearToSrgb(c2));
      return [args[0], args[1], args[2]];
    }
    if (name === "display-p3") {
      return [args[0], args[1], args[2]];
    }
    return null;
  }
  function parseColorMix(fn) {
    let state = "in";
    let space = "";
    const colors = [];
    let current = null;
    for (const node of fn.nodes) {
      if (node.type === "space") continue;
      if (state === "in") {
        if (node.type === "word" && node.value.toLowerCase() === "in") {
          state = "space";
          continue;
        }
        return null;
      }
      if (state === "space") {
        if (node.type !== "word") return null;
        space = node.value;
        state = "color";
        continue;
      }
      if (state === "color") {
        if (node.type === "div" && node.value === ",") continue;
        const rgb = resolveColorNode(node);
        if (!rgb) return null;
        current = { rgb, weight: null };
        colors.push(current);
        state = "weight";
        continue;
      }
      if (state === "weight") {
        if (node.type === "div" && node.value === ",") {
          state = "color";
          continue;
        }
        if (node.type === "word" && node.value.endsWith("%")) {
          const w2 = parseFloat(node.value) / 100;
          if (Number.isNaN(w2) || !current) return null;
          current.weight = w2;
          state = "comma";
          continue;
        }
        return null;
      }
      if (state === "comma") {
        if (node.type === "div" && node.value === ",") {
          state = "color";
          continue;
        }
        return null;
      }
    }
    if (colors.length !== 2) return null;
    return { space, colors };
  }
  function convertColorMix(space, colors) {
    const s2 = space.toLowerCase();
    if (s2 !== "srgb" && s2 !== "oklab") return null;
    let w1 = colors[0].weight ?? 0.5;
    let w2 = colors[1].weight ?? 0.5;
    if (colors[0].weight === null && colors[1].weight === null) {
      w1 = 0.5;
      w2 = 0.5;
    } else if (colors[0].weight === null) {
      w1 = 1 - w2;
    } else if (colors[1].weight === null) {
      w2 = 1 - w1;
    }
    const total = w1 + w2;
    const toSpace = (rgb) => s2 === "oklab" ? srgbToOklab(rgb[0], rgb[1], rgb[2]) : rgb;
    const a2 = toSpace(colors[0].rgb);
    const b2 = toSpace(colors[1].rgb);
    const mixed = [
      (a2[0] * w1 + b2[0] * w2) / total,
      (a2[1] * w1 + b2[1] * w2) / total,
      (a2[2] * w1 + b2[2] * w2) / total
    ];
    return s2 === "oklab" ? oklabToSrgb(mixed[0], mixed[1], mixed[2]) : mixed;
  }
  function formatRgb(rgb, alpha) {
    const r2 = Math.round(clamp01(rgb[0]) * 255);
    const g2 = Math.round(clamp01(rgb[1]) * 255);
    const b2 = Math.round(clamp01(rgb[2]) * 255);
    if (alpha !== null) {
      const a2 = Math.round(clamp01(alpha) * 1e4) / 1e4;
      return `rgb(${r2} ${g2} ${b2} / ${a2})`;
    }
    return `rgb(${r2} ${g2} ${b2})`;
  }
  function convertFunction(fn) {
    const name = fn.value.toLowerCase();
    if (!CONVERTIBLE_FUNCS.has(name)) return null;
    if (name === "color-mix") {
      const parsed = parseColorMix(fn);
      if (!parsed) return null;
      const rgb2 = convertColorMix(parsed.space, parsed.colors);
      if (!rgb2) return null;
      return formatRgb(rgb2, null);
    }
    let space = "";
    const args = [];
    let sawSlash = false;
    let alpha = null;
    const fnNodes = fn.nodes;
    for (const node of fnNodes) {
      if (node.type === "space") continue;
      if (name === "color" && space === "") {
        if (node.type !== "word") return null;
        space = node.value;
        continue;
      }
      if (node.type === "div" && node.value === "/") {
        sawSlash = true;
        continue;
      }
      if (node.type === "word") {
        const isPct = node.value.endsWith("%");
        const n2 = parseFloat(node.value);
        if (Number.isNaN(n2)) return null;
        if (sawSlash) {
          alpha = n2;
          continue;
        }
        args.push(name === "hwb" && isPct ? n2 / 100 : n2);
        continue;
      }
      return null;
    }
    if (args.length !== 3) return null;
    let rgb = null;
    if (name === "hwb") rgb = convertHwb(args);
    else if (name === "oklab") rgb = convertOklab(args);
    else if (name === "oklch") rgb = convertOklch(args);
    else if (name === "lab") rgb = convertLab(args);
    else if (name === "lch") rgb = convertLch(args);
    else if (name === "color") rgb = convertColorFn(args, space);
    if (!rgb) return null;
    return formatRgb(rgb, alpha);
  }
  function parseRgbToNumbers(rgb) {
    const m2 = rgb.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ [\d.]+)?\)$/);
    if (!m2) return null;
    return [parseInt(m2[1], 10) / 255, parseInt(m2[2], 10) / 255, parseInt(m2[3], 10) / 255];
  }
  function convertColorValue(value) {
    if (!needsColorRewrite(value)) return null;
    const parsed = (0, import_postcss_value_parser2.default)(value);
    let changed = false;
    let blocked = false;
    parsed.walk((node) => {
      if (blocked || node.type !== "function") return;
      if (!CONVERTIBLE_FUNCS.has(node.value.toLowerCase())) return;
      const out = convertFunction(node);
      if (out === null) {
        blocked = true;
        return;
      }
      node.type = "word";
      node.value = out;
      node.nodes = [];
      changed = true;
    });
    if (blocked) return null;
    if (!changed) return null;
    return parsed.toString();
  }

  // src/main/modules/userscripts/bundled-scripts/css-fixer-core.ts
  var PSEUDOS_TO_UNWRAP = /* @__PURE__ */ new Set([":where", ":is"]);
  var DVH_RE = /(?:\d+\.?\d*)dvh\b/;
  var DVH_REPLACE_RE = /(\d+(?:\.\d+)?)dvh\b/g;
  var CQ_DUMMY = "container-query-polyfill";
  function needsRewrite(css) {
    return css.includes(":where(") || css.includes(":is(") || css.includes(":has(") || css.includes("@layer") || css.includes("@container") || css.includes("&") || DVH_RE.test(css) || needsColorRewrite(css);
  }
  function flattenLayers(root2) {
    const layers = [];
    root2.walkAtRules("layer", (atRule2) => {
      layers.push(atRule2);
    });
    for (const atRule2 of layers) {
      if (atRule2.nodes && atRule2.nodes.length > 0) {
        const nodes = atRule2.nodes.slice();
        const first = nodes[0];
        if (first.raws) {
          first.raws.before = atRule2.raws.before ?? first.raws.before;
        }
        atRule2.replaceWith(...nodes);
      } else {
        atRule2.remove();
      }
    }
  }
  function splitSelectorList(selectorText) {
    const parts = [];
    let depth = 0;
    let quote = "";
    let current = "";
    for (let i2 = 0; i2 < selectorText.length; i2++) {
      const ch = selectorText[i2];
      if (quote) {
        current += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(" || ch === "[") depth += 1;
      if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current.trim());
    return parts;
  }
  function expandNestedSelector(parentSelector, childSelector) {
    const parents = splitSelectorList(parentSelector);
    const children = splitSelectorList(childSelector);
    const out = [];
    const hasAmp = childSelector.includes("&");
    for (const parent of parents) {
      for (const child of children) {
        out.push(hasAmp ? child.split("&").join(parent) : `${parent} ${child}`);
      }
    }
    return out.join(", ");
  }
  function flattenNesting(root2) {
    let changed = true;
    while (changed) {
      changed = false;
      const parents = [];
      root2.walkRules((rule2) => {
        if (rule2.nodes && rule2.nodes.some((n2) => n2.type === "rule")) parents.push(rule2);
      });
      for (const parent of parents) {
        if (!parent.nodes) continue;
        const children = parent.nodes.filter((n2) => n2.type === "rule");
        if (children.length === 0) continue;
        changed = true;
        const hoisted = children.map((child) => {
          const clone = child.clone();
          clone.selector = expandNestedSelector(parent.selector, clone.selector);
          return clone;
        });
        for (const child of children) child.remove();
        const first = hoisted[0];
        if (first.raws) {
          first.raws.before = parent.raws.before ?? first.raws.before;
        }
        if (parent.nodes.length === 0) {
          parent.replaceWith(...hoisted);
        } else {
          parent.after(hoisted);
        }
      }
    }
  }
  function appendDummyToSelector(selectorText) {
    const root2 = (0, import_postcss_selector_parser3.default)().astSync(selectorText);
    const makeDummy = () => {
      const inner = import_postcss_selector_parser3.default.selector({ value: "" });
      inner.append(import_postcss_selector_parser3.default.className({ value: CQ_DUMMY }));
      const pseudo = import_postcss_selector_parser3.default.pseudo({ value: ":not" });
      pseudo.append(inner);
      return pseudo;
    };
    for (const selNode of root2.nodes) {
      const nodes = selNode.nodes;
      const first = nodes[0];
      const firstSpaces = first.spaces;
      if (firstSpaces) {
        firstSpaces.before = "";
        firstSpaces.after = "";
      }
      const last = nodes[nodes.length - 1];
      if (last.type === "pseudo" && last.value.startsWith("::")) {
        selNode.insertBefore(last, makeDummy());
      } else {
        selNode.append(makeDummy());
      }
    }
    return root2.toString();
  }
  function addContainerDummies(root2) {
    root2.walkAtRules("container", (atRule2) => {
      atRule2.walkRules((rule2) => {
        const parent = rule2.parent;
        if (parent && parent.type === "atrule" && /keyframes/i.test(parent.name)) return;
        if (rule2.selector.includes(`:not(.${CQ_DUMMY})`)) return;
        try {
          rule2.selector = appendDummyToSelector(rule2.selector);
        } catch {
        }
      });
    });
  }
  function unwrapClone(node) {
    const clone = node.clone();
    const spaces = clone.spaces;
    if (spaces) {
      spaces.before = "";
      spaces.after = "";
    }
    return clone;
  }
  function processSelectorNode(selNode) {
    const children = selNode.nodes;
    for (let i2 = 0; i2 < children.length; i2++) {
      const child = children[i2];
      if (child.type !== "pseudo") continue;
      if (!PSEUDOS_TO_UNWRAP.has(child.value)) continue;
      const inner = child.nodes;
      if (!inner || inner.length === 0) continue;
      if (inner.length === 1) {
        const replacement = inner[0].nodes.map((node) => unwrapClone(node));
        for (const node of replacement) selNode.insertBefore(child, node);
        selNode.removeChild(child);
        return processSelectorNode(selNode);
      }
      if (children.length === 1) {
        const branches = [];
        for (const branch of inner) {
          const copy = import_postcss_selector_parser3.default.selector({ value: "" });
          branch.nodes.forEach((node, idx) => {
            if (idx === 0) {
              copy.append(unwrapClone(node));
              return;
            }
            copy.append(node.clone());
          });
          branches.push(...processSelectorNode(copy));
        }
        return branches;
      }
      return [selNode];
    }
    return [selNode];
  }
  function rewriteSelector(selectorText) {
    const root2 = (0, import_postcss_selector_parser3.default)().astSync(selectorText);
    const branches = root2.nodes.flatMap((selNode) => processSelectorNode(selNode));
    const rewritten = branches.map((branch) => branch.toString()).join(", ");
    return rewritten === selectorText ? selectorText : rewritten;
  }
  function rewriteDvh(value) {
    if (!DVH_RE.test(value)) return value;
    const parsed = (0, import_postcss_value_parser3.default)(value);
    parsed.walk((node) => {
      if (node.type === "word") {
        node.value = node.value.replace(DVH_REPLACE_RE, "$1vh");
      }
    });
    return parsed.toString();
  }
  function rewriteCssText(css) {
    if (!needsRewrite(css)) return css;
    let root2 = postcss_default.parse(css);
    if (css.includes(":has(")) {
      const pre = postcss_default.parse(css);
      pre.walkRules((rule2) => {
        try {
          const rewritten = rewriteSelector(rule2.selector);
          if (rewritten !== rule2.selector) rule2.selector = rewritten;
        } catch {
        }
      });
      const preCss = pre.toString();
      if (preCss.includes(":has(")) {
        try {
          const converted = postcss_default([creator({ preserve: false })]).process(preCss, { from: void 0 });
          root2 = postcss_default.parse(converted.css.replace(/\.js-has-pseudo\s+/g, ""));
        } catch {
          root2 = postcss_default.parse(preCss);
        }
      }
    }
    flattenLayers(root2);
    flattenNesting(root2);
    addContainerDummies(root2);
    root2.walkRules((rule2) => {
      const parent = rule2.parent;
      if (parent && parent.type === "atrule" && /keyframes/i.test(parent.name)) return;
      try {
        const rewritten = rewriteSelector(rule2.selector);
        if (rewritten !== rule2.selector) rule2.selector = rewritten;
      } catch {
      }
    });
    root2.walkDecls((decl2) => {
      let out = decl2.value;
      const dvh = rewriteDvh(out);
      if (dvh !== out) out = dvh;
      if (needsColorRewrite(out)) {
        const colors = convertColorValue(out);
        if (colors !== null && colors !== out) out = colors;
      }
      if (out !== decl2.value) decl2.value = out;
    });
    return root2.toString();
  }

  // src/main/modules/userscripts/bundled-scripts/vendor/container-query-polyfill.js
  function e3() {
    return e3 = Object.assign ? Object.assign.bind() : function(e4) {
      for (var t3 = 1; t3 < arguments.length; t3++) {
        var n2 = arguments[t3];
        for (var r2 in n2) Object.prototype.hasOwnProperty.call(n2, r2) && (e4[r2] = n2[r2]);
      }
      return e4;
    }, e3.apply(this, arguments);
  }
  function t2(e4, t3) {
    const n2 = t3.width, r2 = t3.height, u2 = t3.inlineSize, o2 = t3.blockSize;
    switch (e4) {
      case 1:
        return null != n2 ? { type: 3, value: n2, unit: "px" } : { type: 1 };
      case 3:
        return null != u2 ? { type: 3, value: u2, unit: "px" } : { type: 1 };
      case 2:
        return null != r2 ? { type: 3, value: r2, unit: "px" } : { type: 1 };
      case 4:
        return null != o2 ? { type: 3, value: o2, unit: "px" } : { type: 1 };
      case 5:
        return null != n2 && null != r2 && r2 > 0 ? { type: 2, value: n2 / r2 } : { type: 1 };
      case 6:
        return null != n2 && null != r2 ? { type: 4, value: r2 >= n2 ? "portrait" : "landscape" } : { type: 1 };
    }
  }
  function n(e4, t3) {
    switch (e4.type) {
      case 1:
      case 2:
      case 3:
      case 4:
        return i(e4, t3);
      case 5: {
        const n2 = t3.sizeFeatures.get(e4.feature);
        return null == n2 ? { type: 1 } : n2;
      }
      case 6:
        return e4.value;
    }
  }
  function r(e4) {
    return { type: 5, value: e4 };
  }
  function u(e4, t3, n2) {
    return r((function(e5, t4, n3) {
      switch (n3) {
        case 1:
          return e5 === t4;
        case 2:
          return e5 > t4;
        case 3:
          return e5 >= t4;
        case 4:
          return e5 < t4;
        case 5:
          return e5 <= t4;
      }
    })(e4, t3, n2));
  }
  function o(e4, t3, n2) {
    return null == e4 ? t3 : null == t3 ? e4 : n2(e4, t3);
  }
  function s(e4, t3) {
    switch (e4) {
      case "cqw":
        return t3.cqw;
      case "cqh":
        return t3.cqh;
      case "cqi":
        return 0 === t3.writingAxis ? t3.cqw : t3.cqh;
      case "cqb":
        return 1 === t3.writingAxis ? t3.cqw : t3.cqh;
      case "cqmin":
        return o(s("cqi", t3), s("cqb", t3), Math.min);
      case "cqmax":
        return o(s("cqi", t3), s("cqb", t3), Math.max);
    }
  }
  function l(e4, { treeContext: t3 }) {
    switch (e4.unit) {
      case "px":
        return e4.value;
      case "rem":
        return e4.value * t3.rootFontSize;
      case "em":
        return e4.value * t3.fontSize;
      case "cqw":
      case "cqh":
      case "cqi":
      case "cqb":
      case "cqmin":
      case "cqmax":
        return o(e4.value, s(e4.unit, t3), (e5, t4) => e5 * t4);
    }
    return null;
  }
  function c(e4, t3) {
    switch (e4.type) {
      case 2:
        return 0 === e4.value ? 0 : null;
      case 3:
        return l(e4, t3);
    }
    return null;
  }
  function i(e4, t3) {
    switch (e4.type) {
      case 4:
        return (function(e5, t4) {
          const o2 = n(e5.left, t4), s2 = n(e5.right, t4), l2 = e5.operator;
          if (4 === o2.type && 4 === s2.type || 5 === o2.type && 5 === s2.type) return (function(e6, t5, n2) {
            return 1 === n2 ? r(e6.value === t5.value) : { type: 1 };
          })(o2, s2, l2);
          if (3 === o2.type || 3 === s2.type) {
            const e6 = c(o2, t4), n2 = c(s2, t4);
            if (null != e6 && null != n2) return u(e6, n2, l2);
          } else if (2 === o2.type && 2 === s2.type) return u(o2.value, s2.value, l2);
          return { type: 1 };
        })(e4, t3);
      case 2:
        return (function(e5, t4) {
          const n2 = i(e5.left, t4);
          return 5 !== n2.type || true !== n2.value ? n2 : i(e5.right, t4);
        })(e4, t3);
      case 3:
        return (function(e5, t4) {
          const n2 = i(e5.left, t4);
          return 5 === n2.type && true === n2.value ? n2 : i(e5.right, t4);
        })(e4, t3);
      case 1: {
        const n2 = i(e4.value, t3);
        return 5 === n2.type ? { type: 5, value: !n2.value } : { type: 1 };
      }
      case 5:
        return a(n(e4, t3));
      case 6:
        return a(e4.value);
    }
  }
  function a(e4) {
    switch (e4.type) {
      case 5:
        return e4;
      case 2:
      case 3:
        return { type: 5, value: e4.value > 0 };
    }
    return { type: 1 };
  }
  var f = Array.from({ length: 4 }, () => Math.floor(256 * Math.random()).toString(16)).join("");
  var p = S("container");
  var y = S("container-type");
  var h = S("container-name");
  var v = `data-cqs-${f}`;
  var d = `data-cqc-${f}`;
  var m = S("cqw");
  var w = S("cqh");
  var g = S("cqi");
  var b = S("cqb");
  function S(e4) {
    return `--cq-${e4}-${f}`;
  }
  var x = /* @__PURE__ */ Symbol();
  function q(e4, t3) {
    const n2 = { value: t3, errorIndices: [], index: -1, at(r2) {
      const u2 = n2.index + r2;
      return u2 >= e4.length ? t3 : e4[u2];
    }, consume: (e5) => (n2.index += e5, n2.value = n2.at(0), n2.value), reconsume() {
      n2.index -= 1;
    }, error() {
      n2.errorIndices.push(n2.index);
    } };
    return n2;
  }
  function C(e4) {
    return q(e4, { type: 0 });
  }
  function* $(e4) {
    const t3 = [];
    let n2 = false;
    for (const r3 of e4) {
      const e5 = r3.codePointAt(0);
      n2 && 10 !== e5 && (n2 = false, t3.push(10)), 0 === e5 || e5 >= 55296 && e5 <= 57343 ? t3.push(65533) : 13 === e5 ? n2 = true : t3.push(e5);
    }
    const r2 = q(t3, -1), { at: u2, consume: o2, error: s2, reconsume: l2 } = r2;
    function c2() {
      return String.fromCodePoint(r2.value);
    }
    function i2() {
      return { type: 13, value: c2() };
    }
    function a2() {
      for (; z(u2(1)); ) o2(1);
    }
    function f2() {
      for (; -1 !== r2.value; ) if (o2(1), 42 === u2(0) && 47 === u2(1)) return void o2(1);
      s2();
    }
    function p2() {
      const [e5, t4] = (function() {
        let e6 = 0, t5 = "", n4 = u2(1);
        for (43 !== n4 && 45 !== n4 || (o2(1), t5 += c2()); k(u2(1)); ) o2(1), t5 += c2();
        if (46 === u2(1) && k(u2(2))) for (e6 = 1, o2(1), t5 += c2(); k(u2(1)); ) o2(1), t5 += c2();
        if (n4 = u2(1), 69 === n4 || 101 === n4) {
          const n5 = u2(2);
          if (k(n5)) for (e6 = 1, o2(1), t5 += c2(); k(u2(1)); ) o2(1), t5 += c2();
          else if ((45 === n5 || 43 === n5) && k(u2(3))) for (e6 = 1, o2(1), t5 += c2(), o2(1), t5 += c2(); k(u2(1)); ) o2(1), t5 += c2();
        }
        return [t5, e6];
      })(), n3 = u2(1);
      return d2(n3, u2(1), u2(2)) ? { type: 15, value: e5, flag: t4, unit: w2() } : 37 === n3 ? (o2(1), { type: 16, value: e5 }) : { type: 17, value: e5, flag: t4 };
    }
    function y2() {
      const e5 = w2();
      let t4 = u2(1);
      if ("url" === e5.toLowerCase() && 40 === t4) {
        for (o2(1); z(u2(1)) && z(u2(2)); ) o2(1);
        t4 = u2(1);
        const n3 = u2(2);
        return 34 === t4 || 39 === t4 ? { type: 23, value: e5 } : !z(t4) || 34 !== n3 && 39 !== n3 ? (function() {
          let e6 = "";
          for (a2(); ; ) {
            const n4 = o2(1);
            if (41 === n4) return { type: 20, value: e6 };
            if (-1 === n4) return s2(), { type: 20, value: e6 };
            if (z(n4)) {
              a2();
              const t6 = u2(1);
              return 41 === t6 || -1 === t6 ? (o2(1), -1 === n4 && s2(), { type: 20, value: e6 }) : (g2(), { type: 21 });
            }
            if (34 === n4 || 39 === n4 || 40 === n4 || (t5 = n4) >= 0 && t5 <= 8 || 11 === t5 || t5 >= 14 && t5 <= 31 || 127 === t5) return s2(), g2(), { type: 21 };
            if (92 === n4) {
              if (!j(n4, u2(1))) return s2(), { type: 21 };
              e6 += v2();
            } else e6 += c2();
          }
          var t5;
        })() : { type: 23, value: e5 };
      }
      return 40 === t4 ? (o2(1), { type: 23, value: e5 }) : { type: 24, value: e5 };
    }
    function h2(e5) {
      let t4 = "";
      for (; ; ) {
        const n3 = o2(1);
        if (-1 === n3 || n3 === e5) return -1 === n3 && s2(), { type: 2, value: t4 };
        if (E(n3)) return s2(), l2(), { type: 3 };
        if (92 === n3) {
          const e6 = u2(1);
          if (-1 === e6) continue;
          E(e6) ? o2(1) : t4 += v2();
        } else t4 += c2();
      }
    }
    function v2() {
      const e5 = o2(1);
      if (A(e5)) {
        const t4 = [e5];
        for (let e6 = 0; e6 < 5; e6++) {
          const e7 = u2(1);
          if (!A(e7)) break;
          t4.push(e7), o2(1);
        }
        z(u2(1)) && o2(1);
        let n3 = parseInt(String.fromCodePoint(...t4), 16);
        return (0 === n3 || n3 >= 55296 && n3 <= 57343 || n3 > 1114111) && (n3 = 65533), String.fromCodePoint(n3);
      }
      return -1 === e5 ? (s2(), String.fromCodePoint(65533)) : c2();
    }
    function d2(e5, t4, n3) {
      return 45 === e5 ? L(t4) || 45 === t4 || j(t4, n3) : !!L(e5);
    }
    function m2(e5, t4, n3) {
      return 43 === e5 || 45 === e5 ? k(t4) || 46 === t4 && k(n3) : !(46 !== e5 || !k(t4)) || !!k(e5);
    }
    function w2() {
      let e5 = "";
      for (; ; ) {
        const t4 = o2(1);
        if (M(t4)) e5 += c2();
        else {
          if (!j(t4, u2(1))) return l2(), e5;
          e5 += v2();
        }
      }
    }
    function g2() {
      for (; ; ) {
        const e5 = o2(1);
        if (-1 === e5) return;
        j(e5, u2(1)) && v2();
      }
    }
    for (; ; ) {
      const e5 = o2(1);
      if (47 === e5 && 42 === u2(1)) o2(2), f2();
      else if (z(e5)) a2(), yield { type: 1 };
      else if (34 === e5) yield h2(e5);
      else if (35 === e5) {
        const e6 = u2(1);
        M(e6) || j(e6, u2(2)) ? yield { type: 14, flag: d2(u2(1), u2(2), u2(3)) ? 1 : 0, value: w2() } : yield i2();
      } else if (39 === e5) yield h2(e5);
      else if (40 === e5) yield { type: 4 };
      else if (41 === e5) yield { type: 5 };
      else if (43 === e5) m2(e5, u2(1), u2(2)) ? (l2(), yield p2()) : yield i2();
      else if (44 === e5) yield { type: 6 };
      else if (45 === e5) {
        const t4 = u2(1), n3 = u2(2);
        m2(e5, t4, n3) ? (l2(), yield p2()) : 45 === t4 && 62 === n3 ? (o2(2), yield { type: 19 }) : d2(e5, t4, n3) ? (l2(), yield y2()) : yield i2();
      } else if (46 === e5) m2(e5, u2(1), u2(2)) ? (l2(), yield p2()) : yield i2();
      else if (58 === e5) yield { type: 7 };
      else if (59 === e5) yield { type: 8 };
      else if (60 === e5) 33 === u2(1) && 45 === u2(2) && 45 === u2(3) ? yield { type: 18 } : yield i2();
      else if (64 === e5) if (d2(u2(1), u2(2), u2(3))) {
        const e6 = w2();
        yield { type: 22, value: e6 };
      } else yield i2();
      else if (91 === e5) yield { type: 9 };
      else if (92 === e5) j(e5, u2(1)) ? (l2(), yield y2()) : (s2(), yield i2());
      else if (93 === e5) yield { type: 10 };
      else if (123 === e5) yield { type: 11 };
      else if (125 === e5) yield { type: 12 };
      else if (k(e5)) l2(), yield p2();
      else if (L(e5)) l2(), yield y2();
      else {
        if (-1 === e5) return yield { type: 0 }, r2.errorIndices;
        yield { type: 13, value: c2() };
      }
    }
  }
  function k(e4) {
    return e4 >= 48 && e4 <= 57;
  }
  function A(e4) {
    return k(e4) || e4 >= 65 && e4 <= 70 || e4 >= 97 && e4 <= 102;
  }
  function E(e4) {
    return 10 === e4 || 13 === e4 || 12 === e4;
  }
  function z(e4) {
    return E(e4) || 9 === e4 || 32 === e4;
  }
  function L(e4) {
    return e4 >= 65 && e4 <= 90 || e4 >= 97 && e4 <= 122 || e4 >= 128 || 95 === e4;
  }
  function j(e4, t3) {
    return 92 === e4 && !E(t3);
  }
  function M(e4) {
    return L(e4) || k(e4) || 45 === e4;
  }
  var T = { 11: 12, 9: 10, 4: 5 };
  function P(t3, n2) {
    const r2 = (function(e4, t4) {
      const n3 = [];
      for (; ; ) switch (e4.consume(1).type) {
        case 1:
          break;
        case 0:
          return { type: 3, value: n3 };
        case 18:
        case 19:
          if (false !== t4) {
            e4.reconsume();
            const t5 = R(e4);
            t5 !== x && n3.push(t5);
          }
          break;
        case 22:
          e4.reconsume(), n3.push(U(e4));
          break;
        default: {
          e4.reconsume();
          const t5 = R(e4);
          t5 !== x && n3.push(t5);
          break;
        }
      }
    })(C(t3), true === n2);
    return e3({}, r2, { value: r2.value.map((t4) => 26 === t4.type ? (function(t5, n3) {
      return 0 === t5.value.value.type ? e3({}, t5, { value: e3({}, t5.value, { value: O(t5.value.value.value) }) }) : t5;
    })(t4) : t4) });
  }
  function N(e4) {
    const t3 = C(e4), n2 = [];
    for (; ; ) {
      if (0 === t3.consume(1).type) return n2;
      t3.reconsume(), n2.push(Q(t3));
    }
  }
  function O(e4) {
    return (function(e5) {
      const t3 = [], n2 = [];
      for (; ; ) {
        const r2 = e5.consume(1);
        switch (r2.type) {
          case 1:
          case 8:
            break;
          case 0:
            return { type: 1, value: [...n2, ...t3] };
          case 22:
            e5.reconsume(), t3.push(U(e5));
            break;
          case 24: {
            const t4 = [r2];
            let u2 = e5.at(1);
            for (; 8 !== u2.type && 0 !== u2.type; ) t4.push(Q(e5)), u2 = e5.at(1);
            const o2 = I(C(t4));
            o2 !== x && n2.push(o2);
            break;
          }
          case 13:
            if ("&" === r2.value) {
              e5.reconsume();
              const n3 = R(e5);
              n3 !== x && t3.push(n3);
              break;
            }
          default: {
            e5.error(), e5.reconsume();
            let t4 = e5.at(1);
            for (; 8 !== t4.type && 0 !== t4.type; ) Q(e5), t4 = e5.at(1);
            break;
          }
        }
      }
    })(C(e4));
  }
  function F(e4) {
    for (; 1 === e4.at(1).type; ) e4.consume(1);
  }
  function U(e4) {
    let t3 = e4.consume(1);
    if (22 !== t3.type) throw new Error(`Unexpected type ${t3.type}`);
    const n2 = t3.value, r2 = [];
    for (; ; ) switch (t3 = e4.consume(1), t3.type) {
      case 8:
        return { type: 25, name: n2, prelude: r2, value: null };
      case 0:
        return e4.error(), { type: 25, name: n2, prelude: r2, value: null };
      case 11:
        return { type: 25, name: n2, prelude: r2, value: H(e4) };
      case 28:
        if (11 === t3.source.type) return { type: 25, name: n2, prelude: r2, value: t3 };
      default:
        e4.reconsume(), r2.push(Q(e4));
    }
  }
  function R(e4) {
    let t3 = e4.value;
    const n2 = [];
    for (; ; ) switch (t3 = e4.consume(1), t3.type) {
      case 0:
        return e4.error(), x;
      case 11:
        return { type: 26, prelude: n2, value: H(e4) };
      case 28:
        if (11 === t3.source.type) return { type: 26, prelude: n2, value: t3 };
      default:
        e4.reconsume(), n2.push(Q(e4));
    }
  }
  function I(e4) {
    const t3 = e4.consume(1);
    if (24 !== t3.type) throw new Error(`Unexpected type ${t3.type}`);
    const n2 = t3.value, r2 = [];
    let u2 = false;
    if (F(e4), 7 !== e4.at(1).type) return e4.error(), x;
    for (e4.consume(1), F(e4); 0 !== e4.at(1).type; ) r2.push(Q(e4));
    const o2 = r2[r2.length - 2], s2 = r2[r2.length - 1];
    return o2 && 13 === o2.type && "!" === o2.value && 24 === s2.type && "important" === s2.value.toLowerCase() && (u2 = true, r2.splice(r2.length - 2)), { type: 29, name: n2, value: r2, important: u2 };
  }
  function Q(e4) {
    const t3 = e4.consume(1);
    switch (t3.type) {
      case 11:
      case 9:
      case 4:
        return H(e4);
      case 23:
        return (function(e5) {
          let t4 = e5.value;
          if (23 !== t4.type) throw new Error(`Unexpected type ${t4.type}`);
          const n2 = t4.value, r2 = [];
          for (; ; ) switch (t4 = e5.consume(1), t4.type) {
            case 5:
              return { type: 27, name: n2, value: r2 };
            case 0:
              return e5.error(), { type: 27, name: n2, value: r2 };
            default:
              e5.reconsume(), r2.push(Q(e5));
          }
        })(e4);
      default:
        return t3;
    }
  }
  function H(e4) {
    let t3 = e4.value;
    const n2 = t3, r2 = T[n2.type];
    if (!r2) throw new Error(`Unexpected type ${t3.type}`);
    const u2 = [];
    for (; ; ) switch (t3 = e4.consume(1), t3.type) {
      case r2:
        return { type: 28, source: n2, value: { type: 0, value: u2 } };
      case 0:
        return e4.error(), { type: 28, source: n2, value: { type: 0, value: u2 } };
      default:
        e4.reconsume(), u2.push(Q(e4));
    }
  }
  function V(e4) {
    return F(e4), 0 === e4.at(1).type;
  }
  var D = { 11: ["{", "}"], 9: ["[", "]"], 4: ["(", ")"] };
  function W(e4, t3) {
    switch (e4.type) {
      case 25:
        return `@${CSS.escape(e4.name)} ${e4.prelude.map((e5) => W(e5)).join("")}${e4.value ? W(e4.value) : ";"}`;
      case 26:
        return `${e4.prelude.map((e5) => W(e5)).join("")}${W(e4.value)}`;
      case 28: {
        const [t4, n2] = D[e4.source.type];
        return `${t4}${_(e4.value)}${n2}`;
      }
      case 27:
        return `${CSS.escape(e4.name)}(${e4.value.map((e5) => W(e5)).join("")})`;
      case 29:
        return `${CSS.escape(e4.name)}:${e4.value.map((e5) => W(e5)).join("")}${e4.important ? " !important" : ""}`;
      case 1:
        return " ";
      case 8:
        return ";";
      case 7:
        return ":";
      case 14:
        return "#" + CSS.escape(e4.value);
      case 24:
        return CSS.escape(e4.value);
      case 15:
        return e4.value + CSS.escape(e4.unit);
      case 13:
      case 17:
        return e4.value;
      case 2:
        return `"${CSS.escape(e4.value)}"`;
      case 6:
        return ",";
      case 20:
        return "url(" + CSS.escape(e4.value) + ")";
      case 22:
        return "@" + CSS.escape(e4.value);
      case 16:
        return e4.value + "%";
      default:
        throw new Error(`Unsupported token ${e4.type}`);
    }
  }
  function _(e4, t3) {
    return e4.value.map((t4) => {
      let n2 = W(t4);
      return 29 === t4.type && 0 !== e4.type && (n2 += ";"), n2;
    }).join("");
  }
  function B(e4) {
    return W(e4);
  }
  function G(e4) {
    const t3 = e4.at(1);
    return 13 === t3.type && "=" === t3.value && (e4.consume(1), true);
  }
  function Y(e4, t3) {
    const n2 = [];
    for (; ; ) {
      const r2 = e4.at(1);
      if (0 === r2.type || t3 && 7 === r2.type || 13 === r2.type && (">" === r2.value || "<" === r2.value || "=" === r2.value)) break;
      n2.push(e4.consume(1));
    }
    return n2;
  }
  function J(e4) {
    F(e4);
    const t3 = e4.consume(1);
    return 13 !== t3.type ? x : ">" === t3.value ? G(e4) ? 3 : 2 : "<" === t3.value ? G(e4) ? 5 : 4 : "=" === t3.value ? 1 : x;
  }
  function K(e4) {
    return 4 === e4 || 5 === e4;
  }
  function X(e4) {
    return 2 === e4 || 3 === e4;
  }
  function Z(e4, t3, n2) {
    const r2 = (function(e5) {
      F(e5);
      const t4 = e5.consume(1);
      return F(e5), 24 !== t4.type || 0 !== e5.at(1).type ? x : t4.value;
    })(C(e4));
    if (r2 === x) return x;
    let u2 = r2.toLowerCase();
    return u2 = n2 ? n2(u2) : u2, t3.has(u2) ? u2 : x;
  }
  function ee(e4) {
    return { type: 13, value: e4 };
  }
  function te(e4, t3) {
    return { type: 29, name: e4, value: t3, important: false };
  }
  function ne(e4) {
    return { type: 24, value: e4 };
  }
  function re(e4, t3) {
    return { type: 27, name: e4, value: t3 };
  }
  function ue(e4) {
    return re("var", [ne(e4)]);
  }
  function oe(e4, t3) {
    F(e4);
    let n2 = false, r2 = e4.at(1);
    if (24 === r2.type) {
      if ("not" !== r2.value.toLowerCase()) return x;
      e4.consume(1), F(e4), n2 = true;
    }
    let u2 = (function(e5) {
      const t4 = e5.consume(1);
      switch (t4.type) {
        case 28: {
          if (4 !== t4.source.type) return x;
          const e6 = oe(C(t4.value.value), null);
          return e6 !== x ? e6 : { type: 4, value: t4 };
        }
        case 27:
          return { type: 4, value: t4 };
        default:
          return x;
      }
    })(e4);
    if (u2 === x) return x;
    u2 = n2 ? { type: 1, value: u2 } : u2, F(e4), r2 = e4.at(1);
    const o2 = 24 === r2.type ? r2.value.toLowerCase() : null;
    if (null !== o2) {
      if (e4.consume(1), F(e4), "and" !== o2 && "or" !== o2 || null !== t3 && o2 !== t3) return x;
      const n3 = oe(e4, o2);
      return n3 === x ? x : { type: "and" === o2 ? 2 : 3, left: u2, right: n3 };
    }
    return V(e4) ? u2 : x;
  }
  function se(e4) {
    return oe(e4, null);
  }
  function le(e4) {
    switch (e4.type) {
      case 1:
        return [ne("not"), { type: 1 }, ...le(e4.value)];
      case 2:
      case 3:
        return [...le(e4.left), { type: 1 }, ne(2 === e4.type ? "and" : "or"), { type: 1 }, ...le(e4.right)];
      case 4:
        return [e4.value];
    }
  }
  var ce = { width: 1, height: 2, "inline-size": 3, "block-size": 4, "aspect-ratio": 5, orientation: 6 };
  var ie = new Set(Object.keys(ce));
  var ae = /* @__PURE__ */ new Set(["none", "and", "not", "or", "normal", "auto"]);
  var fe = /* @__PURE__ */ new Set(["initial", "inherit", "revert", "revert-layer", "unset"]);
  var pe = /* @__PURE__ */ new Set(["size", "inline-size"]);
  function ye(e4, t3, n2, r2) {
    const u2 = n2();
    if (u2 === x) return x;
    let o2 = [u2, null];
    F(e4);
    const s2 = e4.at(1);
    if (13 === s2.type) {
      if (s2.value !== t3) return x;
      e4.consume(1), F(e4);
      const n3 = r2();
      F(e4), n3 !== x && (o2 = [u2, n3]);
    }
    return V(e4) ? o2 : x;
  }
  function he(e4) {
    const t3 = e4.consume(1);
    return 17 === t3.type ? parseInt(t3.value) : x;
  }
  function ve(e4) {
    const t3 = C(e4);
    F(t3);
    const n2 = t3.consume(1);
    let r2 = x;
    switch (n2.type) {
      case 17:
        t3.reconsume(), r2 = (function(e5) {
          const t4 = ye(e5, "/", () => he(e5), () => he(e5));
          return t4 === x ? x : { type: 2, value: t4[0] / (null !== t4[1] ? t4[1] : 1) };
        })(t3);
        break;
      case 15:
        r2 = { type: 3, value: parseInt(n2.value), unit: n2.unit.toLowerCase() };
        break;
      case 24: {
        const e5 = n2.value.toLowerCase();
        switch (e5) {
          case "landscape":
          case "portrait":
            r2 = { type: 4, value: e5 };
        }
      }
    }
    return r2 === x ? x : V(t3) ? { type: 6, value: r2 } : x;
  }
  function de(e4) {
    return !ge(e4 = e4.toLowerCase()) && !ae.has(e4);
  }
  function me(e4, t3) {
    const n2 = [];
    for (; ; ) {
      F(e4);
      const r2 = e4.at(1);
      if (24 !== r2.type || !t3(r2.value)) return n2;
      e4.consume(1), n2.push(r2.value);
    }
  }
  function we(e4) {
    const t3 = [];
    for (; ; ) {
      F(e4);
      const n2 = e4.at(1);
      if (24 !== n2.type) break;
      const r2 = n2.value;
      if (!de(r2)) break;
      e4.consume(1), t3.push(r2);
    }
    return t3;
  }
  function ge(e4) {
    return fe.has(e4);
  }
  function be(e4) {
    return e4.map((e5) => "cq-" + e5);
  }
  function Se(e4) {
    const t3 = me(e4, (e5) => ge(e5));
    return 1 === t3.length ? be(t3) : x;
  }
  function xe(e4, t3) {
    const n2 = me(e4, (e5) => "none" === e5);
    if (1 === n2.length) return be(n2);
    if (0 !== n2.length) return x;
    if (t3) {
      const t4 = Se(e4);
      if (t4 !== x) return t4;
    }
    const r2 = we(e4);
    return r2.length > 0 && (!t3 || V(e4)) ? r2 : x;
  }
  function qe(e4, t3) {
    if (t3) {
      const t4 = Se(e4);
      if (t4 !== x) return t4;
    }
    return (function(e5) {
      const t4 = me(e5, (e6) => "normal" === e6);
      if (1 === t4.length) return be(t4);
      if (0 !== t4.length) return x;
      const n2 = me(e5, (e6) => pe.has(e6));
      return n2.length > 0 && V(e5) ? n2 : x;
    })(e4);
  }
  function Ce(e4) {
    const t3 = C(e4), n2 = Se(t3);
    if (n2 !== x) return [n2, n2];
    const r2 = ye(t3, "/", () => xe(t3, false), () => qe(t3, false));
    return r2 !== x && V(t3) ? [r2[0], r2[1] || []] : x;
  }
  function $e(e4) {
    const t3 = C(e4), n2 = we(t3);
    if (!n2 || n2.length > 1) return x;
    const r2 = se(t3);
    if (r2 === x) return x;
    const u2 = { features: /* @__PURE__ */ new Set() }, o2 = ke(r2, u2);
    return V(t3) ? { name: n2.length > 0 ? n2[0] : null, condition: o2, features: u2.features } : x;
  }
  function ke(e4, t3) {
    switch (e4.type) {
      case 1:
        return { type: 1, value: ke(e4.value, t3) };
      case 2:
      case 3:
        return { type: 2 === e4.type ? 2 : 3, left: ke(e4.left, t3), right: ke(e4.right, t3) };
      case 4:
        if (28 === e4.value.type) {
          const n2 = (function(e5, t4) {
            const n3 = (function(e6, t5) {
              const n4 = Y(e6, true), r3 = e6.at(1);
              if (0 === r3.type) {
                const e7 = Z(n4, t5);
                return e7 !== x && t5.has(e7) ? { type: 1, feature: e7 } : x;
              }
              if (7 === r3.type) {
                e6.consume(1);
                const r4 = Y(e6, false);
                let u3 = 1;
                const o3 = Z(n4, t5, (e7) => e7.startsWith("min-") ? (u3 = 3, e7.substring(4)) : e7.startsWith("max-") ? (u3 = 5, e7.substring(4)) : e7);
                return o3 !== x ? { type: 2, feature: o3, bounds: [null, [u3, r4]] } : x;
              }
              const u2 = J(e6);
              if (u2 === x) return x;
              const o2 = Y(e6, false);
              if (0 === e6.at(1).type) {
                const e7 = Z(n4, t5);
                if (e7 !== x) return { type: 2, feature: e7, bounds: [null, [u2, o2]] };
                const r4 = Z(o2, t5);
                return r4 !== x ? { type: 2, feature: r4, bounds: [[u2, n4], null] } : x;
              }
              const s2 = J(e6);
              if (s2 === x || !(X(u2) && X(s2) || K(u2) && K(s2))) return x;
              const l2 = Y(e6, false), c2 = Z(o2, t5);
              return c2 !== x ? { type: 2, feature: c2, bounds: [[u2, n4], [s2, l2]] } : x;
            })(e5, ie);
            if (n3 === x) return x;
            const r2 = ce[n3.feature];
            if (null == r2) return x;
            if (t4.features.add(r2), 1 === n3.type) return { type: 5, feature: r2 };
            {
              const e6 = { type: 5, feature: r2 };
              let t5 = x;
              if (null !== n3.bounds[0]) {
                const r3 = ve(n3.bounds[0][1]);
                if (r3 === x) return x;
                t5 = { type: 4, operator: n3.bounds[0][0], left: r3, right: e6 };
              }
              if (null !== n3.bounds[1]) {
                const r3 = ve(n3.bounds[1][1]);
                if (r3 === x) return x;
                const u2 = { type: 4, operator: n3.bounds[1][0], left: e6, right: r3 };
                t5 = t5 !== x ? { type: 2, left: t5, right: u2 } : u2;
              }
              return t5;
            }
          })(C(e4.value.value.value), t3);
          if (n2 !== x) return n2;
        }
        return { type: 6, value: { type: 1 } };
    }
  }
  var Ae = 0;
  var Ee = { cqw: m, cqh: w, cqi: g, cqb: b };
  var ze = CSS.supports("selector(:where(div))");
  var Le = ":not(.container-query-polyfill)";
  N(Array.from($(Le)));
  var je = document.createElement("div");
  var Me = /* @__PURE__ */ new Set(["before", "after", "first-line", "first-letter"]);
  function Te(e4, t3) {
    return re("calc", [{ type: 17, flag: e4.flag, value: e4.value }, ee("*"), t3]);
  }
  function Pe(t3) {
    return t3.map((t4) => {
      switch (t4.type) {
        case 15:
          return (function(e4) {
            const t5 = e4.unit, n2 = Ee[t5];
            return null != n2 ? Te(e4, ue(n2)) : "cqmin" === t5 || "cqmax" === t5 ? Te(e4, re(e4.unit.slice(2), [ue(g), { type: 6 }, ue(b)])) : e4;
          })(t4);
        case 27:
          return e3({}, t4, { value: Pe(t4.value) });
      }
      return t4;
    });
  }
  function Ne(t3) {
    switch (t3.name) {
      case "container":
        return Ce(t3.value) ? e3({}, t3, { name: p }) : t3;
      case "container-name":
        return xe(C(t3.value), true) ? e3({}, t3, { name: h }) : t3;
      case "container-type":
        return null != qe(C(t3.value), true) ? e3({}, t3, { name: y }) : t3;
    }
    return e3({}, t3, { value: Pe(t3.value) });
  }
  function Oe(t3, n2) {
    return e3({}, t3, { value: t3.value.map((t4) => {
      switch (t4.type) {
        case 25:
          return He(t4, n2);
        case 26:
          return (function(t5, n3) {
            return n3.transformStyleRule(e3({}, t5, { value: Re(t5.value, n3) }));
          })(t4, n2);
        default:
          return t4;
      }
    }) });
  }
  function Fe(e4) {
    return 0 === e4.type || 6 === e4.type;
  }
  function Ue(e4) {
    for (let t3 = e4.length - 1; t3 >= 0; t3--) if (1 !== e4[t3].type) return e4.slice(0, t3 + 1);
    return e4;
  }
  function Re(t3, n2) {
    return (function(t4, n3) {
      const r2 = [];
      let u2 = null, o2 = null;
      for (const e4 of t4.value.value) switch (e4.type) {
        case 25:
          {
            const t5 = n3 ? n3(e4) : e4;
            t5 && r2.push(t5);
          }
          break;
        case 29: {
          const t5 = Ne(e4);
          switch (t5.name) {
            case p: {
              const t6 = Ce(e4.value);
              t6 !== x && (u2 = t6[0], o2 = t6[1]);
              break;
            }
            case h: {
              const t6 = xe(C(e4.value), true);
              t6 !== x && (u2 = t6);
              break;
            }
            case y: {
              const t6 = qe(C(e4.value), true);
              t6 !== x && (o2 = t6);
              break;
            }
            default:
              r2.push(t5);
          }
        }
      }
      return u2 && u2.length > 0 && r2.push(te(h, [ne(u2.join(" "))])), o2 && o2.length > 0 && r2.push(te(y, [ne(o2.join(" "))])), e3({}, t4, { value: { type: 2, value: r2 } });
    })(t3, (e4) => He(e4, n2));
  }
  function Ie(t3) {
    if (1 === t3.type) return e3({}, t3, { value: Ie(t3.value) });
    if (2 === t3.type || 3 === t3.type) return e3({}, t3, { left: Ie(t3.left), right: Ie(t3.right) });
    if (4 === t3.type && 28 === t3.value.type) {
      const n2 = (function(e4) {
        const t4 = C(e4);
        return F(t4), 24 !== t4.at(1).type ? x : I(t4) || x;
      })(t3.value.value.value);
      if (n2 !== x) return e3({}, t3, { value: e3({}, t3.value, { value: { type: 0, value: [Ne(n2)] } }) });
    }
    return t3;
  }
  function Qe(t3, n2) {
    let r2 = se(C(t3.prelude));
    return r2 = r2 !== x ? Ie(r2) : x, e3({}, t3, { prelude: r2 !== x ? le(r2) : t3.prelude, value: t3.value ? e3({}, t3.value, { value: Oe(P(t3.value.value.value), n2) }) : null });
  }
  function He(t3, n2) {
    switch (t3.name.toLocaleLowerCase()) {
      case "media":
      case "layer":
        return (function(t4, n3) {
          return e3({}, t4, { value: t4.value ? e3({}, t4.value, { value: Oe(P(t4.value.value.value), n3) }) : null });
        })(t3, n2);
      case "keyframes":
        return (function(t4, n3) {
          let r2 = null;
          return t4.value && (r2 = e3({}, t4.value, { value: { type: 3, value: P(t4.value.value.value).value.map((t5) => {
            switch (t5.type) {
              case 26:
                return (function(t6, n4) {
                  return e3({}, t6, { value: Re(t6.value, n4) });
                })(t5, n3);
              case 25:
                return He(t5, n3);
            }
          }) } })), e3({}, t4, { value: r2 });
        })(t3, n2);
      case "supports":
        return Qe(t3, n2);
      case "container":
        return (function(t4, n3) {
          if (t4.value) {
            const r2 = $e(t4.prelude);
            if (r2 !== x) {
              const u2 = { rule: r2, selector: null, parent: n3.parent, uid: "c" + Ae++ }, o2 = /* @__PURE__ */ new Set(), s2 = [], l2 = Oe(P(t4.value.value.value), { descriptors: n3.descriptors, parent: u2, transformStyleRule: (t5) => {
                const [n4, r3] = (function(e4, t6, n5) {
                  const r4 = C(e4), u3 = [], o3 = [];
                  for (; ; ) {
                    if (0 === r4.at(1).type) return [u3, o3];
                    const n6 = Math.max(0, r4.index);
                    for (; l4 = r4.at(1), c2 = r4.at(2), !(Fe(l4) || 7 === l4.type && (7 === c2.type || 24 === c2.type && Me.has(c2.value.toLowerCase()))); ) r4.consume(1);
                    const i2 = r4.index + 1, a2 = e4.slice(n6, i2), f2 = a2.length > 0 ? Ue(a2) : [ee("*")];
                    for (; !Fe(r4.at(1)); ) r4.consume(1);
                    const p2 = e4.slice(i2, Math.max(0, r4.index + 1));
                    let y2 = f2, h2 = [{ type: 28, source: { type: 9 }, value: { type: 0, value: [ne(p2.length > 0 ? v : d), ee("~"), ee("="), { type: 2, value: t6 }] } }];
                    if (ze) h2 = [ee(":"), re("where", h2)];
                    else {
                      const e5 = f2.map(B).join("");
                      e5.endsWith(Le) ? y2 = N(Array.from($(e5.substring(0, e5.length - Le.length)))) : s2.push({ actual: e5, expected: e5 + Le });
                    }
                    u3.push(...f2), o3.push(...y2), o3.push(...h2), o3.push(...p2), r4.consume(1);
                  }
                  var l4, c2;
                })(t5.prelude, u2.uid);
                if (s2.length > 0) return t5;
                const l3 = n4.map(B).join("");
                try {
                  je.matches(l3), o2.add(l3);
                } catch (e4) {
                }
                return e3({}, t5, { prelude: r3 });
              } }).value;
              if (s2.length > 0) {
                const e4 = /* @__PURE__ */ new Set(), t5 = [];
                let n4 = 0;
                for (const { actual: e5 } of s2) n4 = Math.max(n4, e5.length);
                const r3 = Array.from({ length: n4 }, () => " ").join("");
                for (const { actual: u3, expected: o3 } of s2) e4.has(u3) || (t5.push(`${u3}${r3.substring(0, n4 - u3.length)} => ${o3}`), e4.add(u3));
                console.warn(`The :where() pseudo-class is not supported by this browser. To use the Container Query Polyfill, you must modify the selectors under your @container rules:

${t5.join("\n")}`);
              }
              return o2.size > 0 && (u2.selector = Array.from(o2).join(", ")), n3.descriptors.push(u2), { type: 25, name: "media", prelude: [ne("all")], value: e3({}, t4.value, { value: { type: 3, value: l2 } }) };
            }
          }
          return t4;
        })(t3, n2);
    }
    return t3;
  }
  var Ve = class {
    constructor(e4) {
      this.value = void 0, this.value = e4;
    }
  };
  function De(e4, t3) {
    if (e4 === t3) return true;
    if (typeof e4 == typeof t3 && null !== e4 && null !== t3 && "object" == typeof e4) {
      if (Array.isArray(e4)) {
        if (!Array.isArray(t3) || t3.length !== e4.length) return false;
        for (let n2 = 0, r2 = e4.length; n2 < r2; n2++) if (!De(e4[n2], t3[n2])) return false;
        return true;
      }
      if (e4 instanceof Ve) return t3 instanceof Ve && e4.value === t3.value;
      {
        const n2 = Object.keys(e4);
        if (n2.length !== Object.keys(t3).length) return false;
        for (let r2 = 0, u2 = n2.length; r2 < u2; r2++) {
          const u3 = n2[r2];
          if (!De(e4[u3], t3[u3])) return false;
        }
        return true;
      }
    }
    return false;
  }
  var We = /* @__PURE__ */ Symbol("CQ_INSTANCE");
  var _e = /* @__PURE__ */ Symbol("CQ_STYLESHEET");
  var Be = CSS.supports("width: 1svh");
  var Ge = /* @__PURE__ */ new Set(["vertical-lr", "vertical-rl", "sideways-rl", "sideways-lr", "tb", "tb-lr", "tb-rl"]);
  var Ye = ["padding-left", "padding-right", "border-left-width", "border-right-width"];
  var Je = ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"];
  var Ke = /(\w*(\s|-))?(table|ruby)(-\w*)?/;
  var Xe = class {
    constructor(e4) {
      this.node = void 0, this.node = e4;
    }
    connected() {
    }
    disconnected() {
    }
    updated() {
    }
  };
  var Ze = class extends Xe {
    constructor(e4, t3) {
      super(e4), this.context = void 0, this.controller = null, this.styleSheet = null, this.context = t3;
    }
    connected() {
      var e4 = this;
      const t3 = this.node;
      if ("stylesheet" === t3.rel) {
        const n2 = new URL(t3.href, document.baseURI);
        n2.origin === location.origin && (this.controller = rt(async function(r2) {
          const u2 = await fetch(n2.toString(), { signal: r2 }), o2 = await u2.text(), s2 = e4.styleSheet = await e4.context.registerStyleSheet({ source: o2, url: n2, signal: r2 }), l2 = new Blob([s2.source], { type: "text/css" }), c2 = new Image();
          c2.onload = c2.onerror = s2.refresh, c2.src = t3.href = URL.createObjectURL(l2);
        }));
      }
    }
    disconnected() {
      var e4, t3;
      null == (e4 = this.controller) || e4.abort(), this.controller = null, null == (t3 = this.styleSheet) || t3.dispose(), this.styleSheet = null;
    }
  };
  var et = class extends Xe {
    constructor(e4, t3) {
      super(e4), this.context = void 0, this.controller = null, this.styleSheet = null, this.context = t3;
    }
    connected() {
      var e4 = this;
      const n2 = this.node;
      if (!/@container|container-type|container-name|(?:cqw|cqh|cqi|cqb|cqmin|cqmax)/.test(n2.innerHTML || "")) return;
      this.controller = rt(async function(t3) {
        const n3 = e4.node, r2 = e4.styleSheet = await e4.context.registerStyleSheet({ source: n3.innerHTML, signal: t3 });
        n3.innerHTML = r2.source, r2.refresh();
      });
    }
    disconnected() {
      var e4, t3;
      null == (e4 = this.controller) || e4.abort(), this.controller = null, null == (t3 = this.styleSheet) || t3.dispose(), this.styleSheet = null;
    }
  };
  var tt = class extends Xe {
    connected() {
      const e4 = `* { ${y}: cq-normal; ${h}: cq-none; }`;
      this.node.innerHTML = void 0 === window.CSSLayerBlockRule ? e4 : `@layer cq-polyfill-${f} { ${e4} }`;
    }
  };
  var nt = class extends Xe {
    constructor(e4, t3) {
      super(e4), this.context = void 0, this.styles = void 0, this.context = t3, this.styles = window.getComputedStyle(e4);
    }
    connected() {
      this.node.style.cssText = "position: fixed; top: 0; left: 0; visibility: hidden; " + (Be ? "width: 1svw; height: 1svh;" : "width: 1%; height: 1%;");
    }
    updated() {
      const e4 = ct((e5) => this.styles.getPropertyValue(e5));
      this.context.viewportChanged({ width: e4.width, height: e4.height });
    }
  };
  function rt(e4) {
    const t3 = new AbortController();
    return e4(t3.signal).catch((e5) => {
      if (!(e5 instanceof DOMException && "AbortError" === e5.message)) throw e5;
    }), t3;
  }
  function ut(e4) {
    let t3 = 0;
    if (0 === e4.length) return t3;
    if (e4.startsWith("cq-") && ("normal" === (e4 = e4.substring("cq-".length)) || ge(e4))) return t3;
    const n2 = e4.split(" ");
    for (const e5 of n2) switch (e5) {
      case "size":
        t3 |= 3;
        break;
      case "inline-size":
        t3 |= 1;
        break;
      default:
        return 0;
    }
    return t3;
  }
  function ot(e4) {
    let t3 = 0;
    return "none" !== e4 && (t3 |= 1, "contents" === e4 || "inline" === e4 || Ke.test(e4) || (t3 |= 2)), t3;
  }
  function st(e4, t3) {
    return parseFloat(e4(t3));
  }
  function lt(e4, t3) {
    return t3.reduce((t4, n2) => t4 + st(e4, n2), 0);
  }
  function ct(e4) {
    let t3 = 0, n2 = 0;
    return "border-box" === e4("box-sizing") && (t3 = lt(e4, Ye), n2 = lt(e4, Je)), { fontSize: st(e4, "font-size"), width: st(e4, "width") - t3, height: st(e4, "height") - n2 };
  }
  function it(e4) {
    return { containerType: ut(e4(y).trim()), containerNames: (n2 = e4(h).trim(), n2.startsWith("cq-") && ("none" === (n2 = n2.substring("cq-".length)) || ge(n2)) ? /* @__PURE__ */ new Set([]) : new Set(0 === n2.length ? [] : n2.split(" "))), writingAxis: (t3 = e4("writing-mode").trim(), Ge.has(t3) ? 1 : 0), displayFlags: ot(e4("display").trim()) };
    var t3, n2;
  }
  function at(e4, t3, n2) {
    null != n2 ? n2 != e4.getPropertyValue(t3) && e4.setProperty(t3, n2) : e4.removeProperty(t3);
  }
  function ft(e4) {
    const t3 = e4[_e];
    return null != t3 ? t3 : [];
  }
  function pt(e4, t3) {
    e4[_e] = t3;
  }
  new Promise((e4) => {
  }), window.CQPolyfill = { version: "1.0.2" }, "container" in document.documentElement.style || (function(n2) {
    function r2(e4) {
      return e4[We] || null;
    }
    const u2 = document.documentElement;
    if (r2(u2)) return;
    const o2 = document.createElement(`cq-polyfill-${f}`), s2 = document.createElement("style");
    new MutationObserver((e4) => {
      for (const t3 of e4) {
        for (const e5 of t3.removedNodes) {
          const t4 = r2(e5);
          null == t4 || t4.disconnect();
        }
        t3.target.nodeType !== Node.DOCUMENT_NODE && t3.target.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && null === t3.target.parentNode || "attributes" === t3.type && t3.attributeName && (t3.attributeName === v || t3.attributeName === d || t3.target instanceof Element && t3.target.getAttribute(t3.attributeName) === t3.oldValue) || (A2(t3.target).mutate(), S2());
      }
    }).observe(u2, { childList: true, subtree: true, attributes: true, attributeOldValue: true });
    const l2 = new ResizeObserver((e4) => {
      for (const t3 of e4) A2(t3.target).resize();
      A2(u2).update(C2());
    }), c2 = new Xe(u2);
    async function a2(e4, { source: t3, url: n3, signal: r3 }) {
      const o3 = (function(e5, t4) {
        try {
          const n4 = Array.from($(e5));
          if (t4) for (let e6 = 0; e6 < n4.length; e6++) {
            const r5 = n4[e6];
            if (20 === r5.type) r5.value = new URL(r5.value, t4).toString();
            else if (23 === r5.type && "url" === r5.value.toLowerCase()) {
              const r6 = e6 + 1 < n4.length ? n4[e6 + 1] : null;
              r6 && 2 === r6.type && (r6.value = new URL(r6.value, t4).toString());
            }
          }
          const r4 = { descriptors: [], parent: null, transformStyleRule: (e6) => e6 };
          return { source: _(Oe(P(n4, true), r4)), descriptors: r4.descriptors };
        } catch (t5) {
          return console.warn("An error occurred while transpiling stylesheet: " + t5), { source: e5, descriptors: [] };
        }
      })(t3, n3 ? n3.toString() : void 0);
      let s3 = () => {
      }, l3 = () => {
      };
      const c3 = A2(u2);
      let i2 = false;
      return null != r3 && r3.aborted || (l3 = () => {
        if (!i2) {
          const { sheet: t4 } = e4;
          null != t4 && (pt(t4, o3.descriptors), i2 = true, s3 = () => {
            pt(t4), c3.mutate(), S2();
          }, c3.mutate(), S2());
        }
      }), { source: o3.source, dispose: s3, refresh: l3 };
    }
    const p2 = { cqw: null, cqh: null };
    function y2({ width: e4, height: t3 }) {
      p2.cqw = e4, p2.cqh = t3;
    }
    function h2(e4, t3, n3) {
      if (e4 instanceof Element && t3) {
        let r3 = "";
        for (const [n4, u3] of t3.conditions) {
          const t4 = n4.value;
          null != t4.selector && null != u3 && 2 == (2 & u3) && e4.matches(t4.selector) && (r3.length > 0 && (r3 += " "), r3 += t4.uid);
        }
        r3.length > 0 ? e4.setAttribute(n3, r3) : e4.removeAttribute(n3);
      }
    }
    function S2() {
      l2.unobserve(u2), l2.observe(u2);
    }
    const x2 = () => {
      const e4 = [];
      for (const t3 of document.styleSheets) for (const n3 of ft(t3)) e4.push([new Ve(n3), 0]);
      return e4;
    }, q2 = window.getComputedStyle(u2), C2 = () => {
      const t3 = (e4) => q2.getPropertyValue(e4), n3 = it(t3), r3 = ct(t3);
      return { parentState: null, conditions: x2(), context: e3({}, p2, { fontSize: r3.fontSize, rootFontSize: r3.fontSize, writingAxis: n3.writingAxis }), displayFlags: n3.displayFlags, isQueryContainer: false };
    }, k2 = (e4) => e4;
    function A2(n3) {
      let f2 = r2(n3);
      if (!f2) {
        let p3, S3 = null, x3 = false;
        n3 === u2 ? (p3 = c2, S3 = k2) : n3 === o2 ? (x3 = true, p3 = new nt(o2, { viewportChanged: y2 })) : p3 = n3 === s2 ? new tt(s2) : n3 instanceof HTMLLinkElement ? new Ze(n3, { registerStyleSheet: (t3) => a2(n3, e3({}, t3)) }) : n3 instanceof HTMLStyleElement ? new et(n3, { registerStyleSheet: (t3) => a2(n3, e3({}, t3)) }) : new Xe(n3);
        let q3 = /* @__PURE__ */ Symbol();
        if (null == S3 && n3 instanceof Element) {
          const r3 = (function(n4) {
            const r4 = window.getComputedStyle(n4);
            return /* @__PURE__ */ (function(n5) {
              let u3 = null;
              return (...n6) => {
                if (null == u3 || !De(u3[0], n6)) {
                  const o3 = ((n7, u4) => {
                    const { context: o4, conditions: s3 } = n7, l3 = (e4) => r4.getPropertyValue(e4), c3 = it(l3), a3 = e3({}, o4, { writingAxis: c3.writingAxis });
                    let f3 = s3, p4 = false, y3 = c3.displayFlags;
                    0 == (1 & n7.displayFlags) && (y3 = 0);
                    const { containerType: h3, containerNames: v2 } = c3;
                    if (h3 > 0) {
                      const e4 = h3 > 0 && 2 == (2 & y3), n8 = new Map(s3.map((e5) => [e5[0].value, e5[1]]));
                      if (f3 = [], p4 = true, e4) {
                        const e5 = ct(l3);
                        a3.fontSize = e5.fontSize;
                        const r5 = (function(e6, t3) {
                          const n9 = { value: t3.width }, r6 = { value: t3.height };
                          let u6 = n9, o5 = r6;
                          if (1 === e6.writingAxis) {
                            const e7 = u6;
                            u6 = o5, o5 = e7;
                          }
                          return 2 != (2 & e6.containerType) && (o5.value = void 0), { width: n9.value, height: r6.value, inlineSize: u6.value, blockSize: o5.value };
                        })(c3, e5), u5 = { sizeFeatures: r5, treeContext: a3 }, p5 = (e6) => {
                          const { rule: r6 } = e6, o5 = r6.name, s4 = null == o5 || v2.has(o5) ? (function(e7, n9) {
                            const r7 = /* @__PURE__ */ new Map(), u6 = n9.sizeFeatures;
                            for (const n10 of e7.features) {
                              const e8 = t2(n10, u6);
                              if (1 === e8.type) return null;
                              r7.set(n10, e8);
                            }
                            const o6 = i(e7.condition, { sizeFeatures: r7, treeContext: n9.treeContext });
                            return 5 === o6.type ? o6.value : null;
                          })(r6, u5) : null;
                          var l4;
                          return null == s4 ? 1 === ((null != (l4 = n8.get(e6)) ? l4 : 0) && 1) : true === s4;
                        }, y4 = (e6, t3) => {
                          let n9 = e6.get(t3);
                          if (null == n9) {
                            const r6 = p5(t3);
                            n9 = (r6 ? 1 : 0) | (true !== r6 || null != t3.parent && 1 != (1 & y4(e6, t3.parent)) ? 0 : 2), e6.set(t3, n9);
                          }
                          return n9;
                        }, h4 = /* @__PURE__ */ new Map();
                        for (const e6 of s3) f3.push([e6[0], y4(h4, e6[0].value)]);
                        a3.cqw = null != r5.width ? r5.width / 100 : o4.cqw, a3.cqh = null != r5.height ? r5.height / 100 : o4.cqh;
                      }
                    }
                    return { parentState: new Ve(n7), conditions: f3, context: a3, displayFlags: y3, isQueryContainer: p4 };
                  })(...n6);
                  null != u3 && De(u3[1], o3) || (u3 = [n6, o3]);
                }
                return u3[1];
              };
            })();
          })(n3);
          S3 = (e4) => r3(e4, q3);
        }
        const C3 = S3 || k2;
        let $2 = null;
        const E2 = (e4) => {
          const t3 = $2, n4 = C3(e4);
          return $2 = n4, [$2, $2 !== t3];
        }, z2 = n3 instanceof HTMLElement || n3 instanceof SVGElement ? n3.style : null;
        let L2 = false;
        f2 = { connect() {
          for (let e4 = n3.firstChild; null != e4; e4 = e4.nextSibling) A2(e4);
          p3.connected();
        }, disconnect() {
          n3 instanceof Element && (l2.unobserve(n3), n3.removeAttribute(v), n3.removeAttribute(d)), z2 && (z2.removeProperty(g), z2.removeProperty(b), z2.removeProperty(m), z2.removeProperty(w));
          for (let e4 = n3.firstChild; null != e4; e4 = e4.nextSibling) {
            const t3 = r2(e4);
            null == t3 || t3.disconnect();
          }
          p3.disconnected(), delete n3[We];
        }, update(e4) {
          const [t3, r3] = E2(e4);
          if (r3) {
            if (h2(n3, e4, d), h2(n3, t3, v), n3 instanceof Element) {
              const e5 = x3 || t3.isQueryContainer;
              e5 && !L2 ? (l2.observe(n3), L2 = true) : !e5 && L2 && (l2.unobserve(n3), L2 = false);
            }
            if (z2) {
              const n4 = t3.context, r4 = n4.writingAxis;
              let u3 = null, o3 = null, s3 = null, l3 = null;
              (r4 !== e4.context.writingAxis || t3.isQueryContainer) && (u3 = `var(${0 === r4 ? m : w})`, o3 = `var(${1 === r4 ? m : w})`), e4 && !t3.isQueryContainer || (n4.cqw && (s3 = n4.cqw + "px"), n4.cqh && (l3 = n4.cqh + "px")), at(z2, g, u3), at(z2, b, o3), at(z2, m, s3), at(z2, w, l3);
            }
            p3.updated();
          }
          for (let e5 = n3.firstChild; null != e5; e5 = e5.nextSibling) A2(e5).update(t3);
        }, resize() {
          q3 = /* @__PURE__ */ Symbol();
        }, mutate() {
          q3 = /* @__PURE__ */ Symbol();
          for (let e4 = n3.firstChild; null != e4; e4 = e4.nextSibling) A2(e4).mutate();
        } }, n3[We] = f2, f2.connect();
      }
      return f2;
    }
    u2.prepend(s2, o2), A2(u2), S2();
  })();

  // src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.js
  !(function() {
    function decodeCSS(e4) {
      if ("csstools-has-" !== e4.slice(0, 13)) return "";
      for (var t3 = (e4 = e4.slice(13)).split("-"), r2 = "", o2 = 0; o2 < t3.length; o2++) r2 += String.fromCharCode(parseInt(t3[o2], 36));
      return r2;
    }
    function extractEncodedSelectors(e4) {
      for (var t3, r2, o2 = [], n2 = 0, s2 = false, l2 = false, i2 = 0; i2 < e4.length; i2++) {
        var c2 = e4[i2];
        switch (c2) {
          case "[":
            if (s2) {
              t3 += c2;
              continue;
            }
            0 === n2 ? t3 = "" : t3 += c2, n2++;
            continue;
          case "]":
            if (s2) {
              t3 += c2;
              continue;
            }
            0 === --n2 ? l2 && o2.push(decodeCSS(t3)) : t3 += c2;
            continue;
          case "\\":
            t3 += e4[i2], t3 += e4[i2 + 1], i2++;
            continue;
          case '"':
          case "'":
            if (s2 && c2 === r2) {
              s2 = false;
              continue;
            }
            if (s2) {
              t3 += c2;
              continue;
            }
            s2 = true, r2 = c2;
            continue;
          default:
            "" === t3 && 1 === n2 && "csstools-has-" === e4.slice(i2, i2 + 13) && (l2 = true), t3 += c2;
            continue;
        }
      }
      for (var a2 = [], u2 = 0; u2 < o2.length; u2++) -1 === a2.indexOf(o2[u2]) && a2.push(o2[u2]);
      return a2;
    }
    function encodeCSS2(e4) {
      if ("" === e4) return "";
      for (var t3, r2 = "", o2 = 0; o2 < e4.length; o2++) t3 = e4.charCodeAt(o2).toString(36), r2 += 0 === o2 ? t3 : "-" + t3;
      return "csstools-has-" + r2;
    }
    function hasNativeSupport() {
      try {
        if (!("CSS" in self) || !("supports" in self.CSS) || !self.CSS.supports("selector(:has(div))")) return false;
      } catch (e4) {
        return false;
      }
      return true;
    }
    function cssHasPseudo(e4, t3) {
      var r2 = false;
      t3 || (t3 = {}), (t3 = { hover: !!t3.hover || false, debug: !!t3.debug || false, observedAttributes: t3.observedAttributes || [], forcePolyfill: !!t3.forcePolyfill || false }).mustPolyfill = t3.forcePolyfill || !hasNativeSupport(), Array.isArray(t3.observedAttributes) || (t3.observedAttributes = []), t3.observedAttributes = t3.observedAttributes.filter(function(e5) {
        return "string" == typeof e5;
      }), t3.observedAttributes = t3.observedAttributes.concat(["accept", "accept-charset", "accesskey", "action", "align", "allow", "alt", "async", "autocapitalize", "autocomplete", "autofocus", "autoplay", "buffered", "capture", "challenge", "charset", "checked", "cite", "class", "code", "codebase", "cols", "colspan", "content", "contenteditable", "contextmenu", "controls", "coords", "crossorigin", "csp", "data", "datetime", "decoding", "default", "defer", "dir", "dirname", "disabled", "download", "draggable", "enctype", "enterkeyhint", "for", "form", "formaction", "formenctype", "formmethod", "formnovalidate", "formtarget", "headers", "hidden", "high", "href", "hreflang", "http-equiv", "icon", "id", "importance", "integrity", "intrinsicsize", "inputmode", "ismap", "itemprop", "keytype", "kind", "label", "lang", "language", "list", "loop", "low", "manifest", "max", "maxlength", "minlength", "media", "method", "min", "multiple", "muted", "name", "novalidate", "open", "optimum", "pattern", "ping", "placeholder", "poster", "preload", "radiogroup", "readonly", "referrerpolicy", "rel", "required", "reversed", "rows", "rowspan", "sandbox", "scope", "scoped", "selected", "shape", "size", "sizes", "slot", "span", "spellcheck", "src", "srcdoc", "srclang", "srcset", "start", "step", "summary", "tabindex", "target", "title", "translate", "type", "usemap", "value", "width", "wrap"]);
      var o2 = [], n2 = e4.createElement("x");
      if ([].forEach.call(e4.styleSheets, walkStyleSheet), t3.mustPolyfill) {
        if (transformObservedItemsThrottled(), "MutationObserver" in self) {
          var s2 = new MutationObserver(function(t4) {
            t4.forEach(function(t5) {
              [].forEach.call(t5.addedNodes || [], function(e5) {
                1 === e5.nodeType && (e5.sheet ? walkStyleSheet(e5.sheet) : e5.addEventListener("load", function(e6) {
                  e6.target && e6.target.sheet && walkStyleSheet(e6.target.sheet);
                }));
              }), [].push.apply(o2, o2.splice(0).filter(function(t6) {
                return t6.rule.parentStyleSheet && t6.rule.parentStyleSheet.ownerNode && e4.documentElement.contains(t6.rule.parentStyleSheet.ownerNode);
              })), transformObservedItemsThrottled();
            });
          });
          s2.observe(e4, { childList: true, subtree: true, attributes: true, attributeFilter: t3.observedAttributes });
        }
        if (e4.addEventListener("focus", transformObservedItemsThrottled, true), e4.addEventListener("blur", transformObservedItemsThrottled, true), e4.addEventListener("input", transformObservedItemsThrottled), e4.addEventListener("change", transformObservedItemsThrottled, true), t3.hover && ("onpointerenter" in e4 ? (e4.addEventListener("pointerenter", transformObservedItemsThrottled, true), e4.addEventListener("pointerleave", transformObservedItemsThrottled, true)) : (e4.addEventListener("mouseover", transformObservedItemsThrottled, true), e4.addEventListener("mouseout", transformObservedItemsThrottled, true))), "defineProperty" in Object && "getOwnPropertyDescriptor" in Object && "hasOwnProperty" in Object) try {
          let observeProperty2 = function(e5, t4) {
            if (e5.hasOwnProperty(t4)) {
              var r3 = Object.getOwnPropertyDescriptor(e5, t4);
              r3 && r3.configurable && "set" in r3 && Object.defineProperty(e5, t4, { configurable: r3.configurable, enumerable: r3.enumerable, get: function() {
                return r3.get.apply(this, arguments);
              }, set: function() {
                r3.set.apply(this, arguments);
                try {
                  transformObservedItemsThrottled();
                } catch (e6) {
                }
              } });
            }
          };
          var observeProperty = observeProperty2;
          "HTMLElement" in self && HTMLElement.prototype && observeProperty2(HTMLElement.prototype, "disabled"), ["checked", "selected", "readOnly", "required"].forEach(function(e5) {
            ["HTMLButtonElement", "HTMLFieldSetElement", "HTMLInputElement", "HTMLMeterElement", "HTMLOptGroupElement", "HTMLOptionElement", "HTMLOutputElement", "HTMLProgressElement", "HTMLSelectElement", "HTMLTextAreaElement"].forEach(function(t4) {
              t4 in self && self[t4].prototype && observeProperty2(self[t4].prototype, e5);
            });
          });
        } catch (l2) {
          t3.debug && console.error(l2);
        }
      }
      function transformObservedItemsThrottled() {
        r2 && clearTimeout(r2), r2 = setTimeout(function() {
          o2.forEach(function(r3) {
            var o3 = [], s3 = [];
            if (r3.selector) try {
              s3 = e4.querySelectorAll(r3.selector);
            } catch (l2) {
              return void (t3.debug && console.error(l2));
            }
            [].forEach.call(s3, function(t4) {
              o3.push(t4), n2.innerHTML = "<x " + r3.attributeName + ">", t4.setAttributeNode(n2.children[0].attributes[0].cloneNode()), e4.documentElement.style.zoom = 1, e4.documentElement.style.zoom = null;
            }), r3.nodes.forEach(function(t4) {
              -1 === o3.indexOf(t4) && (t4.removeAttribute(r3.attributeName), e4.documentElement.style.zoom = 1, e4.documentElement.style.zoom = null);
            }), r3.nodes = o3;
          });
        });
      }
      function walkStyleSheet(e5) {
        try {
          for (var r3 = e5.cssRules.length - 1; r3 >= 0; r3--) {
            var n3 = e5.cssRules[r3];
            if (n3.selectorText) {
              n3.selectorText = n3.selectorText.replace(/\.js-has-pseudo\s/g, "");
              try {
                var s3 = extractEncodedSelectors(n3.selectorText.toString());
                if (0 === s3.length) continue;
                if (!t3.mustPolyfill) {
                  e5.deleteRule(r3);
                  continue;
                }
                for (var i2 = 0; i2 < s3.length; i2++) {
                  var c2 = s3[i2];
                  c2 && o2.push({ rule: n3, selector: c2, attributeName: encodeCSS2(c2), nodes: [] });
                }
              } catch (l2) {
                t3.debug && console.error(l2);
              }
            } else walkStyleSheet(n3);
          }
        } catch (l2) {
          t3.debug && console.error(l2);
        }
      }
    }
    !(function(e4) {
      try {
        if (e4.document.querySelector(":has(*, :does-not-exist, > *)"), !e4.document.querySelector(":has(:scope *)") && CSS.supports("selector(:has(div))")) return;
      } catch (a2) {
      }
      var t3 = polyfill(e4.Element.prototype.querySelector);
      e4.Element.prototype.querySelector = function querySelector(e5) {
        return t3.apply(this, arguments);
      };
      var r2 = polyfill(e4.Element.prototype.querySelectorAll);
      if (e4.Element.prototype.querySelectorAll = function querySelectorAll(e5) {
        return r2.apply(this, arguments);
      }, e4.Element.prototype.matches) {
        var o2 = polyfill(e4.Element.prototype.matches);
        e4.Element.prototype.matches = function matches(e5) {
          return o2.apply(this, arguments);
        };
      }
      if (e4.Element.prototype.closest) {
        var n2 = polyfill(e4.Element.prototype.closest);
        e4.Element.prototype.closest = function closest(e5) {
          return n2.apply(this, arguments);
        };
      }
      if ("Document" in e4 && "prototype" in e4.Document) {
        var s2 = polyfill(e4.Document.prototype.querySelector);
        e4.Document.prototype.querySelector = function querySelector(e5) {
          return s2.apply(this, arguments);
        };
        var l2 = polyfill(e4.Document.prototype.querySelectorAll);
        if (e4.Document.prototype.querySelectorAll = function querySelectorAll(e5) {
          return l2.apply(this, arguments);
        }, e4.Document.prototype.matches) {
          var i2 = polyfill(e4.Document.prototype.matches);
          e4.Document.prototype.matches = function matches(e5) {
            return i2.apply(this, arguments);
          };
        }
        if (e4.Document.prototype.closest) {
          var c2 = polyfill(e4.Document.prototype.closest);
          e4.Document.prototype.closest = function closest(e5) {
            return c2.apply(this, arguments);
          };
        }
      }
      function pseudoClassHasInnerQuery(e5) {
        for (var t4 = "", r3 = 0, o3 = 0, n3 = false, s3 = false, l3 = false, i3 = false, c3 = 0; c3 < e5.length; c3++) {
          var a2 = e5[c3];
          if (n3) t4 += a2, n3 = false;
          else if (s3) a2 === l3 && (s3 = false), t4 += a2;
          else switch (":has(" !== t4.toLowerCase() || i3 || (i3 = true, r3 = c3, t4 = ""), a2) {
            case ":":
              i3 || (t4 = ""), t4 += a2;
              continue;
            case "(":
              i3 && o3++, t4 += a2;
              continue;
            case ")":
              if (i3) {
                if (0 === o3) return { innerQuery: t4, start: r3, end: c3 - 1 };
                o3--;
              }
              t4 += a2;
              continue;
            case "\\":
              t4 += a2, n3 = true;
              continue;
            case '"':
            case "'":
              t4 += a2, s3 = true, l3 = a2;
              continue;
            default:
              t4 += a2;
              continue;
          }
        }
        return false;
      }
      function replaceScopeWithAttr(e5, t4) {
        for (var r3 = [], o3 = "", n3 = false, s3 = false, l3 = false, i3 = 0, c3 = 0; c3 < e5.length; c3++) {
          var a2 = e5[c3];
          if (n3) o3 += a2, n3 = false;
          else if (s3) a2 === l3 && (s3 = false), o3 += a2;
          else switch (":scope" === o3.toLowerCase() && !i3 && /^[\[\.\:\\"\s|+>~#&,)]/.test(a2 || "") && (r3.push(o3.slice(0, o3.length - 6)), r3.push("[" + t4 + "]"), o3 = ""), a2) {
            case ":":
              r3.push(o3), o3 = "", o3 += a2;
              continue;
            case "\\":
              o3 += a2, n3 = true;
              continue;
            case '"':
            case "'":
              o3 += a2, s3 = true, l3 = a2;
              continue;
            case "[":
              o3 += a2, i3++;
              continue;
            case "]":
              o3 += a2, i3 > 0 && i3--;
              continue;
            default:
              o3 += a2;
              continue;
          }
        }
        return ":scope" === o3.toLowerCase() && (r3.push(o3.slice(0, o3.length - 6)), r3.push("[" + t4 + "]"), o3 = ""), 0 === r3.length ? e5 : r3.join("") + o3;
      }
      function charIsNestedMarkMirror(e5, t4) {
        return "(" === t4 && ")" === e5 || "[" === t4 && "]" === e5;
      }
      function splitSelector(e5) {
        for (var t4 = [], r3 = "", o3 = false, n3 = false, s3 = false, l3 = false, i3 = 0, c3 = 0; c3 < e5.length; c3++) {
          var a2 = e5[c3];
          if (o3) r3 += a2, o3 = false;
          else switch (a2) {
            case ",":
              if (n3) {
                r3 += a2;
                continue;
              }
              if (i3 > 0) {
                r3 += a2;
                continue;
              }
              t4.push(r3), r3 = "";
              continue;
            case "\\":
              r3 += a2, o3 = true;
              continue;
            case '"':
            case "'":
              if (n3 && a2 === s3) {
                r3 += a2, n3 = false;
                continue;
              }
              r3 += a2, n3 = true, s3 = a2;
              continue;
            case "(":
            case ")":
            case "[":
            case "]":
              if (n3) {
                r3 += a2;
                continue;
              }
              if (charIsNestedMarkMirror(a2, l3)) {
                r3 += a2, 0 === --i3 && (l3 = false);
                continue;
              }
              if (a2 === l3) {
                r3 += a2, i3++;
                continue;
              }
              r3 += a2, i3++, l3 = a2;
              continue;
            default:
              r3 += a2;
              continue;
          }
        }
        return t4.push(r3), t4;
      }
      function replaceAllWithTempAttr(e5, t4, r3) {
        var o3 = pseudoClassHasInnerQuery(e5);
        if (!o3) return e5;
        if (t4) return false;
        var n3 = o3.innerQuery, s3 = "q-has" + (Math.floor(9e6 * Math.random()) + 1e6), l3 = "[" + s3 + "]", i3 = e5;
        if (o3.innerQuery.toLowerCase().indexOf(":has(") > -1) {
          for (var c3 = splitSelector(o3.innerQuery), a2 = [], u2 = 0; u2 < c3.length; u2++) {
            var p2 = c3[u2];
            if (!replaceAllWithTempAttr(p2, true, function() {
            })) throw new Error("Nested :has() is not supported");
            a2.push(p2);
          }
          var f2 = i3.substring(0, o3.start - 5), d2 = i3.substring(o3.end + 2);
          return f2 + a2.join(", ") + d2;
        }
        f2 = i3.substring(0, o3.start - 5), d2 = i3.substring(o3.end + 2);
        if (i3 = f2 + l3 + d2, r3(n3, s3), i3.toLowerCase().indexOf(":has(") > -1) {
          var h2 = replaceAllWithTempAttr(i3, false, r3);
          if (h2) return h2;
        }
        return i3;
      }
      function walkNode(e5, t4) {
        if ("setAttribute" in e5 && "querySelector" in e5 && t4(e5), e5.hasChildNodes()) for (var r3 = e5.childNodes, o3 = 0; o3 < r3.length; ++o3) walkNode(r3[o3], t4);
      }
      function polyfill(t4) {
        return function(r3) {
          if (!r3) return t4.apply(this, arguments);
          var o3, n3 = String(r3);
          if (!n3 || -1 === n3.toLowerCase().indexOf(":has(") || !pseudoClassHasInnerQuery(n3)) return t4.apply(this, arguments);
          if ("getRootNode" in this) o3 = this.getRootNode();
          else for (var s3 = this; s3; ) o3 = s3, s3 = s3.parentNode;
          var l3 = this;
          l3 === e4.document && (l3 = e4.document.documentElement);
          var i3 = "q-has-scope" + (Math.floor(9e6 * Math.random()) + 1e6);
          l3.setAttribute(i3, "");
          try {
            n3 = replaceScopeWithAttr(n3, i3);
            var c3 = [i3], u2 = replaceAllWithTempAttr(n3, false, function(e5, t5) {
              c3.push(t5);
              for (var r4 = splitSelector(e5), n4 = 0; n4 < r4.length; n4++) {
                var s4 = r4[n4].trim(), l4 = s4;
                l4 = ">" === s4[0] || "+" === s4[0] || "~" === s4[0] ? s4.slice(1).trim() : ":scope " + s4, walkNode(o3, function(e6) {
                  if (e6.querySelector(l4)) switch (s4[0]) {
                    case "~":
                    case "+":
                      for (var r5 = e6.childNodes, o4 = 0; o4 < r5.length; o4++) {
                        var n5 = r5[o4];
                        if ("setAttribute" in n5) {
                          var i4 = "q-has-id" + (Math.floor(9e6 * Math.random()) + 1e6);
                          n5.setAttribute(i4, ""), e6.querySelector(":scope [" + i4 + "] " + s4) && n5.setAttribute(t5, ""), n5.removeAttribute(i4);
                        }
                      }
                      break;
                    case ">":
                      i4 = "q-has-id" + (Math.floor(9e6 * Math.random()) + 1e6);
                      e6.setAttribute(i4, ""), e6.querySelector(":scope[" + i4 + "] " + s4) && e6.setAttribute(t5, ""), e6.removeAttribute(i4);
                      break;
                    default:
                      e6.setAttribute(t5, "");
                  }
                });
              }
            });
            arguments[0] = u2;
            var p2 = t4.apply(this, arguments);
            if (l3.removeAttribute(i3), c3.length > 0) {
              for (var f2 = [], d2 = 0; d2 < c3.length; d2++) f2.push("[" + c3[d2] + "]");
              for (var h2 = e4.document.querySelectorAll(f2.join(",")), m2 = 0; m2 < h2.length; m2++) for (var y2 = h2[m2], v2 = 0; v2 < c3.length; v2++) y2.removeAttribute(c3[v2]);
            }
            return p2;
          } catch (g2) {
            if (l3.removeAttribute(i3), c3.length > 0) {
              for (f2 = [], d2 = 0; d2 < c3.length; d2++) f2.push("[" + c3[d2] + "]");
              for (h2 = e4.document.querySelectorAll(f2.join(",")), m2 = 0; m2 < h2.length; m2++) for (y2 = h2[m2], v2 = 0; v2 < c3.length; v2++) y2.removeAttribute(c3[v2]);
            }
            var b2 = "";
            try {
              t4.apply(this, [":core-web-does-not-exist"]);
            } catch (S2) {
              b2 = S2.message, b2 && (b2 = b2.replace(":core-web-does-not-exist", n3));
            }
            b2 || (b2 = "Failed to execute 'querySelector' on 'Document': '" + n3 + "' is not a valid selector.");
            try {
              throw new DOMException(b2);
            } catch (a2) {
              throw new Error(b2);
            }
          }
        };
      }
    })(self), ("object" == typeof window && window || "object" == typeof self && self || {}).cssHasPseudo = cssHasPseudo;
  })();

  // src/main/modules/userscripts/bundled-scripts/css-fixer-entry.ts
  var MARKER = "data-bf-css-fixed";
  var MAX_SHEETS = 150;
  var CACHE_DB = "bf-css-fixer";
  var CACHE_STORE = "sheets";
  var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var CACHE_MAX_BYTES = 20 * 1024 * 1024;
  var dbPromise = null;
  function openCacheDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(CACHE_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(CACHE_STORE)) {
            db.createObjectStore(CACHE_STORE, { keyPath: "url" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }
  function cacheGet(url) {
    return openCacheDb().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(url);
          req.onsuccess = () => {
            const row = req.result;
            if (row && typeof row.text === "string" && row.ts && Date.now() - row.ts < CACHE_TTL_MS) {
              resolve(row.text);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
  }
  function cachePut(url, text) {
    return openCacheDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(CACHE_STORE, "readwrite");
        const store = tx.objectStore(CACHE_STORE);
        store.put({ url, text, ts: Date.now(), bytes: text.length });
        const allReq = store.getAll();
        allReq.onsuccess = () => {
          const rows = allReq.result || [];
          const now = Date.now();
          const expired = [];
          let total = 0;
          for (const row of rows) {
            if (now - (row.ts || 0) > CACHE_TTL_MS) expired.push(row.url);
            else total += row.bytes || 0;
          }
          if (expired.length > 0 || total > CACHE_MAX_BYTES) {
            for (const url2 of expired) store.delete(url2);
            const sorted = rows.filter((r2) => !expired.includes(r2.url)).sort((a2, b2) => (a2.ts || 0) - (b2.ts || 0));
            let over = total - CACHE_MAX_BYTES;
            for (const row of sorted) {
              if (over <= 0) break;
              store.delete(row.url);
              over -= row.bytes || 0;
            }
          }
        };
      } catch {
      }
    });
  }
  var HAS_ATTR_RE = /\[(csstools-has-[a-z0-9-]+)\]/;
  var HAS_INNER_RE = /:has\(([^()]*)\)/;
  function decodeHasAttr(encoded) {
    if (!encoded.startsWith("csstools-has-")) return "";
    return encoded.slice(13).split("-").map((x2) => String.fromCharCode(parseInt(x2, 36))).join("");
  }
  function injectSkipHide() {
    try {
      const style = document.createElement("style");
      style.setAttribute("data-bf-skip-hide", "1");
      style.textContent = 'a.skip-navigation,a[href="#start-of-content"],.show-on-focus:not(:focus){position:absolute!important;clip:rect(1px,1px,1px,1px)!important;width:1px!important;height:1px!important;overflow:hidden!important}';
      const head = document.head || document.documentElement;
      head.insertBefore(style, head.firstChild);
    } catch {
    }
  }
  function markHasInSheets() {
    try {
      const sheets = document.styleSheets;
      for (let si = 0; si < sheets.length; si++) {
        const sheet = sheets[si];
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (let i2 = 0; i2 < rules.length; i2++) {
          const text = String(rules[i2].cssText);
          if (!text.includes("csstools-has-")) continue;
          const am = text.match(HAS_ATTR_RE);
          if (!am) continue;
          const attr = am[1];
          const F2 = decodeHasAttr(attr);
          if (!F2) continue;
          const hasMatches = F2.match(/:has\(/g) || [];
          if (hasMatches.length !== 1) continue;
          const innerMatch = F2.match(HAS_INNER_RE);
          if (!innerMatch) continue;
          const inner = innerMatch[1].trim();
          if (/^[>+~]/.test(inner)) continue;
          const hostSel = F2.replace(HAS_INNER_RE, "").trim();
          if (!hostSel) continue;
          let els;
          try {
            els = document.querySelectorAll(inner);
          } catch {
            continue;
          }
          for (let j2 = 0; j2 < els.length; j2++) {
            let host = null;
            try {
              host = els[j2].closest(hostSel);
            } catch {
              break;
            }
            if (host && host !== els[j2]) host.setAttribute(attr, "");
          }
        }
      }
    } catch {
    }
  }
  var markHasTimer = null;
  function scheduleMarkHas() {
    if (markHasTimer !== null) return;
    markHasTimer = window.setTimeout(() => {
      markHasTimer = null;
      markHasInSheets();
    }, 500);
  }
  function startHasReMarkLoop() {
    let rounds = 0;
    const timer = window.setInterval(() => {
      rounds += 1;
      markHasInSheets();
      if (rounds >= 20) window.clearInterval(timer);
    }, 3e3);
    for (const ev of ["click", "mouseenter"]) {
      document.addEventListener(ev, () => scheduleMarkHas(), { capture: true, passive: true });
    }
  }
  var FETCH_TIMEOUT_MS = 1e4;
  var MAX_FETCH_ATTEMPTS = 2;
  function toArray(list2) {
    const out = [];
    for (let i2 = 0; i2 < list2.length; i2++) out.push(list2.item(i2));
    return out;
  }
  function shouldFixNextImage(width, htmlHeight) {
    return htmlHeight > 0 && width > htmlHeight * 2.5;
  }
  function fixNextImage(img) {
    try {
      if (img.getAttribute("width") !== "0") return;
      const h2 = parseInt(img.getAttribute("height") || "", 10);
      if (!Number.isFinite(h2) || h2 <= 0) return;
      const apply = () => {
        const w2 = parseFloat(getComputedStyle(img).width);
        if (Number.isFinite(w2) && shouldFixNextImage(w2, h2)) {
          img.style.width = "auto";
          img.style.height = h2 + "px";
        }
      };
      apply();
      if (!img.complete) {
        img.addEventListener("load", apply, { once: true });
      }
      window.setTimeout(apply, 300);
      window.setTimeout(apply, 1500);
    } catch {
    }
  }
  function fixNextImages(root2) {
    for (const img of toArray(root2.querySelectorAll('img[width="0"][height]'))) {
      fixNextImage(img);
    }
  }
  function processStyle(el) {
    try {
      const lastWrite = el.__bfLastWrite;
      if (el.hasAttribute(MARKER)) {
        if (lastWrite === el.textContent) return;
        el.removeAttribute(MARKER);
      }
      const text = el.textContent || "";
      if (!needsRewrite(text)) {
        el.__bfLastWrite = text;
        return;
      }
      const out = rewriteCssText(text);
      if (out !== text) {
        el.setAttribute(MARKER, "1");
        el.__bfLastWrite = out;
        el.textContent = out;
        scheduleMarkHas();
      } else {
        el.__bfLastWrite = text;
      }
    } catch {
    }
  }
  async function processLink(link, attempt = 0) {
    var _a;
    try {
      if (link.hasAttribute(MARKER)) return;
      if (link.disabled) return;
      const rel = (link.rel || "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet")) return;
      const href = link.href;
      if (!href || /^data:/i.test(href)) return;
      const cachedText = await cacheGet(href);
      let text;
      let overridden = cachedText !== null;
      if (cachedText !== null) {
        text = cachedText;
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(href, { credentials: "same-origin", cache: "force-cache", signal: controller.signal });
          if (!res.ok) throw new Error("HTTP " + res.status);
          text = await res.text();
        } finally {
          clearTimeout(timer);
        }
        const rewritten = rewriteCssText(text);
        if (rewritten !== text) {
          text = rewritten;
          overridden = true;
          void cachePut(href, rewritten);
        }
      }
      if (!overridden) return;
      const style = document.createElement("style");
      style.setAttribute(MARKER, "1");
      style.setAttribute("data-bf-css-fix-source", href);
      style.textContent = text;
      (_a = link.parentNode) == null ? void 0 : _a.insertBefore(style, link.nextSibling);
      scheduleMarkHas();
    } catch {
      if (attempt < MAX_FETCH_ATTEMPTS && link.isConnected) {
        setTimeout(() => {
          void processLink(link, attempt + 1);
        }, 1500 * (attempt + 1));
      }
    }
  }
  function main() {
    try {
      if (typeof CSS === "undefined" || !CSS.supports || CSS.supports("selector(:where(*))")) return;
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
      let processed = 0;
      const handleStyle = (el) => {
        if (processed >= MAX_SHEETS) return;
        processed += 1;
        processStyle(el);
      };
      const handleLink = (link) => {
        if (processed >= MAX_SHEETS) return;
        processed += 1;
        void processLink(link);
      };
      const scheduleReMark = () => scheduleMarkHas();
      const observer = new MutationObserver((mutations) => {
        if (processed >= MAX_SHEETS) {
          observer.disconnect();
          return;
        }
        for (const mutation of mutations) {
          const target = mutation.target;
          if (target && target.nodeType === 1 && target.tagName === "STYLE") {
            handleStyle(target);
            scheduleReMark();
          }
          const added = mutation.addedNodes;
          for (let i2 = 0; i2 < added.length; i2++) {
            const node = added.item(i2);
            if (!node || node.nodeType !== 1) continue;
            const el = node;
            if (el.tagName === "STYLE") {
              handleStyle(el);
              scheduleReMark();
            } else if (el.tagName === "LINK") {
              handleLink(el);
              scheduleReMark();
            } else if (el.tagName === "IMG") {
              fixNextImage(el);
            } else {
              for (const style of toArray(el.querySelectorAll("style"))) handleStyle(style);
              for (const link of toArray(el.querySelectorAll('link[rel~="stylesheet"]'))) handleLink(link);
              if (el.querySelector('style, link[rel~="stylesheet"]')) scheduleReMark();
              fixNextImages(el);
            }
          }
        }
      });
      const start = () => {
        injectSkipHide();
        for (const style of toArray(document.querySelectorAll("style"))) handleStyle(style);
        for (const link of toArray(document.querySelectorAll('link[rel~="stylesheet"]'))) handleLink(link);
        fixNextImages(document);
        markHasInSheets();
        startHasReMarkLoop();
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.documentElement) {
        start();
      } else {
        const watcher = new MutationObserver(() => {
          if (!document.documentElement) return;
          watcher.disconnect();
          start();
        });
        watcher.observe(document, { childList: true });
      }
    } catch {
    }
  }
  main();
})();
/*! Bundled license information:

cssesc/cssesc.js:
  (*! https://mths.be/cssesc v3.0.0 by @mathias *)
*/
