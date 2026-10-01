import React from 'react';

export interface DocSection {
  id: string;
  title: string;
  content: React.ReactNode;
}

export const docSections: DocSection[] = [
  // ── 1. 快速开始 ──────────────────────────────────────────
  {
    id: '快速开始',
    title: '快速开始',
    content: (
      <>
        <h2>快速开始</h2>
        <p>
          Automation Core 让你用 JavaScript / TypeScript 脚本控制浏览器中的 Flash 游戏。
          整体流程：<strong>创建自动化包 → 编写脚本 → 设置权限 → 运行</strong>。
        </p>

        <h3>第一步：创建自动化包</h3>
        <p>
          点击工具栏 <strong>新建自动化包</strong>，输入名称，选择脚本语言（TypeScript / JavaScript）。
          每个包可以包含多个脚本文件，但只有一个<strong>主入口</strong>会在运行时执行。
        </p>

        <h3>第二步：编写脚本</h3>
        <p>
          在脚本编辑器中编写代码。所有 API 通过全局对象 <code>bao</code> 调用。
        </p>
        <pre>{`// 等待 1 秒让页面加载
await bao.time.sleep(1000);

// 识别并点击"开始游戏"按钮
const btn = await bao.ocr.findText({
  kind: 'text',
  text: '开始游戏',
  match: 'contains',
  minConfidence: 0.8,
});
if (btn) {
  await bao.input.click(btn);
  bao.log.info('已点击开始游戏');
}`}</pre>

        <h3>第三步：设置权限</h3>
        <p>
          脚本编辑器下方的<strong>权限</strong>行中勾选脚本需要的能力。
          未勾选的权限在运行时调用会报 <code>PERMISSION_DENIED</code> 错误。
        </p>

        <h3>第四步：运行</h3>
        <p>
          点击 <strong>运行主入口</strong>。脚本在隔离沙箱中执行，结果和日志显示在底部状态栏。
          运行过程中可以随时点击 <strong>停止</strong> 中断。
        </p>

        <h3>完整示例</h3>
        <pre>{`// 捕获游戏画面中的金币区域，读取数字
const金币区域 = {
  unit: 'ratio',
  x: 0.12, y: 0.03,
  width: 0.08, height: 0.025,
};
const count = await bao.ocr.readNumber(金币区域);
bao.log.info('金币数量: ' + count);

// 等待某个区域颜色变化（比如战斗结束）
const 战斗区域 = {
  unit: 'ratio',
  x: 0.5, y: 0.5,
  width: 0.01, height: 0.01,
};
const result = await bao.vision.waitForColor(
  战斗区域,
  ['#FBEC00'],           // 等待黄色出现
  { tolerance: 16, timeoutMs: 30000 }
);
if (result.found) {
  bao.log.info('战斗结束，检测到黄色');
}`}</pre>
      </>
    ),
  },

  // ── 2. 权限与沙箱 ──────────────────────────────────────────
  {
    id: '权限与沙箱',
    title: '权限与沙箱',
    content: (
      <>
        <h2>权限与沙箱</h2>
        <p>
          脚本运行在完全隔离的沙箱中，无法直接访问 DOM、window 或 Node.js。
          所有操作必须通过 <code>bao.*</code> API 进行。
        </p>

        <h3>可用权限</h3>
        <table>
          <thead>
            <tr><th>权限</th><th>解锁的 API</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>input</code></td><td><code>bao.input.*</code></td><td>鼠标点击、移动、拖拽、键盘输入</td></tr>
            <tr><td><code>vision</code></td><td><code>bao.vision.*</code></td><td>图像识别、区域变化监控、颜色检测</td></tr>
            <tr><td><code>ocr</code></td><td><code>bao.ocr.*</code></td><td>文字识别（需要 OCR 模块）</td></tr>
            <tr><td><code>page.read</code></td><td><code>bao.page.url()</code></td><td>读取当前页面 URL</td></tr>
            <tr><td><code>page.navigate</code></td><td><code>bao.page.navigate()</code><br/><code>bao.page.reload()</code></td><td>页面导航</td></tr>
            <tr><td><code>log</code></td><td><code>bao.log.*</code></td><td>输出日志到状态栏</td></tr>
            <tr><td><code>notify</code></td><td><code>bao.notify.show()</code></td><td>弹出系统通知</td></tr>
          </tbody>
        </table>
        <p>
          <code>bao.time.*</code> <strong>不需要任何权限</strong>，但受预算限制（见预算与限制章节）。
        </p>

        <h3>沙箱安全边界</h3>
        <ul>
          <li>脚本运行在独立的隐藏 BrowserWindow 中，<code>nodeIntegration: false</code>，<code>contextIsolation: true</code></li>
          <li>所有网络请求（HTTP / HTTPS / WebSocket / file / FTP）被 CSP 策略阻断</li>
          <li>无法发起导航、下载、权限申请</li>
          <li>脚本无法读取或修改浏览器 cookie、localStorage</li>
          <li>运行超时后自动终止，防止死循环</li>
        </ul>

        <h3>三层权限校验</h3>
        <ol>
          <li><strong>脚本声明</strong> — 在 <code>@grant</code> 头中声明需要的权限</li>
          <li><strong>用户审批</strong> — 安装时用户逐项批准</li>
          <li><strong>运行时拦截</strong> — broker 在每次 API 调用时校验，不匹配则拒绝</li>
        </ol>
      </>
    ),
  },

  // ── 3. 坐标系统 ──────────────────────────────────────────
  {
    id: '坐标系统',
    title: '坐标系统',
    content: (
      <>
        <h2>坐标系统</h2>
        <p>
          Automation Core 提供两种坐标单位：<code>logical</code>（逻辑像素）和 <code>ratio</code>（比例坐标）。
          选择不同的单位会影响坐标在窗口缩放、形变下的稳定性。
        </p>

        <h3>逻辑坐标 vs 比例坐标</h3>
        <table>
          <thead>
            <tr><th>单位</th><th>范围</th><th>特点</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>logical</code></td>
              <td>像素值</td>
              <td>直观，但<strong>未选中游戏画面时</strong>受窗口大小和形变影响</td>
            </tr>
            <tr>
              <td><code>ratio</code></td>
              <td>0–10000（整数）<br/>或 0–1（小数）</td>
              <td><strong>选中游戏画面后</strong>不受窗口变化影响，更稳定</td>
            </tr>
          </tbody>
        </table>

        <h3>游戏画面选中 vs 未选中</h3>
        <div className="doc-callout doc-warn">
          <strong>重要：</strong>是否选中游戏画面决定了坐标的稳定性。
        </div>
        <table>
          <thead>
            <tr><th>状态</th><th>坐标行为</th><th>适用场景</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>未选中游戏画面</strong></td>
              <td>坐标基于整个 BrowserView 视口。窗口大小改变、页面缩放、窗口最大化/还原都会导致同一位置的坐标值变化。</td>
              <td>简单的固定布局页面</td>
            </tr>
            <tr>
              <td><strong>选中游戏画面</strong></td>
              <td>坐标基于游戏画面区域，自动补偿窗口缩放和 DPR。窗口大小改变后同一位置的坐标值保持不变。</td>
              <td>Flash 游戏、需要跨窗口状态运行的脚本</td>
            </tr>
          </tbody>
        </table>

        <h3>PersistedRegion（区域定义）</h3>
        <p>
          区域由左上角坐标和宽高定义，用于 OCR 读取、颜色监控等场景：
        </p>
        <pre>{`// ratio 坐标（推荐）— 相对游戏画面的比例位置
{
  unit: 'ratio',
  x: 1200,       // 左上角 X（0–10000 对应画面 0%–100%）
  y: 300,        // 左上角 Y
  width: 800,    // 宽度
  height: 250,   // 高度
}

// logical 坐标 — 像素值，受窗口影响
{
  unit: 'logical',
  x: 100,
  y: 50,
  width: 200,
  height: 40,
}`}</pre>

        <h3>坐标原点</h3>
        <p>
          原点 <code>(0, 0)</code> 在游戏画面（或视口）的<strong>左上角</strong>。
          X 轴向右增大，Y 轴向下增大。
        </p>

        <h3>建议</h3>
        <ul>
          <li>Flash 游戏自动化优先使用 <code>ratio</code> 坐标，确保窗口变化后脚本仍能正常运行</li>
          <li>如果游戏画面未填满整个窗口，<code>ratio</code> 坐标会自动映射到游戏画面区域内</li>
          <li>使用截图工具的坐标时，注意区分是视口坐标还是游戏画面坐标</li>
        </ul>
      </>
    ),
  },

  // ── 4. TargetRef ──────────────────────────────────────────
  {
    id: 'TargetRef',
    title: 'TargetRef',
    content: (
      <>
        <h2>TargetRef（目标引用）</h2>
        <p>
          TargetRef 是 <code>bao.input.*</code> 方法的统一目标参数。
          它将<strong>定位器</strong>（Locator）与<strong>点击位置</strong>（anchor）和<strong>偏移</strong>（offset）组合在一起。
        </p>

        <h3>结构</h3>
        <pre>{`{
  locator: LocatorSpec,     // 必填：如何找到目标
  anchor?: Anchor,          // 可选：点击目标的哪个位置（默认 'center'）
  offset?: PersistedVector, // 可选：从锚点偏移多少
  selection?: SelectionPolicy, // 可选：多个匹配时如何选择
}`}</pre>

        <h3>Anchor（锚点）</h3>
        <p>指定点击目标的哪个位置：</p>
        <table>
          <thead>
            <tr><th>值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>'center'</code></td><td>目标中心（默认）</td></tr>
            <tr><td><code>'top-left'</code></td><td>左上角</td></tr>
            <tr><td><code>'top-right'</code></td><td>右上角</td></tr>
            <tr><td><code>'bottom-left'</code></td><td>左下角</td></tr>
            <tr><td><code>'bottom-right'</code></td><td>右下角</td></tr>
            <tr><td><code>{'{{ xRatio: 0.3, yRatio: 0.7 }}'}</code></td><td>自定义比例位置（0–10000）</td></tr>
          </tbody>
        </table>

        <h3>Offset（偏移）</h3>
        <p>从锚点位置偏移指定的像素值：</p>
        <pre>{`{
  locator: { kind: 'image', asset: 'btn.png' },
  anchor: 'center',
  offset: { x: 10, y: -5 }, // 向右 10px，向上 5px
}`}</pre>

        <h3>SelectionPolicy（选择策略）</h3>
        <p>当定位器找到多个匹配时，决定使用哪一个：</p>
        <table>
          <thead>
            <tr><th>策略</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>{'{{ kind: "best" }}'}</code></td><td>置信度最高的（默认）</td></tr>
            <tr><td><code>{'{{ kind: "first" }}'}</code></td><td>第一个匹配</td></tr>
            <tr><td><code>{'{{ kind: "last" }}'}</code></td><td>最后一个匹配</td></tr>
            <tr><td><code>{'{{ kind: "index", index: 2 }}'}</code></td><td>第 N 个匹配（从 0 开始）</td></tr>
            <tr><td><code>{'{{ kind: "nearest", to: { x: 500, y: 300 } }}'}</code></td><td>距离指定点最近的</td></tr>
          </tbody>
        </table>

        <h3>简化写法</h3>
        <p>
          如果只需要 locator，可以省略其他字段：
        </p>
        <pre>{`// 简化写法 — 等价于 { locator: { kind: 'image', asset: 'btn.png' } }
await bao.input.click({ kind: 'image', asset: 'btn.png' });

// 完整写法 — 指定锚点和偏移
await bao.input.click({
  locator: { kind: 'image', asset: 'btn.png' },
  anchor: 'top-left',
  offset: { x: 5, y: 5 },
});`}</pre>
      </>
    ),
  },

  // ── 5. Locator 类型 ──────────────────────────────────────
  {
    id: 'Locator',
    title: 'Locator 类型',
    content: (
      <>
        <h2>Locator 类型</h2>
        <p>
          Locator 告诉平台"在哪里找到目标"。支持四种定位方式，可组合使用。
        </p>

        <h3>CoordinateLocator（坐标定位）</h3>
        <p>直接指定屏幕坐标：</p>
        <pre>{`{
  kind: 'coordinate',
  point: { unit: 'ratio', x: 5000, y: 5000 }  // 画面正中心
}`}</pre>

        <h3>ImageLocator（图像定位）</h3>
        <p>在画面中查找匹配的图片：</p>
        <pre>{`{
  kind: 'image',
  asset: 'assets/start-button.png',  // 模板图片路径
  threshold: 0.9,                     // 匹配置信度 0–1
  method: 'auto',                     // 'template' | 'color' | 'auto'
  alternatives: ['assets/start-hover.png'],  // 图片组（最多 100 张）
  scales: [1.0, 1.2, 1.5],           // 显式缩放因子
  mask: 'auto',                       // 'auto' | 'none' | 'alpha'
  region: { unit: 'ratio', x: 0, y: 0, width: 10000, height: 10000 },
}`}</pre>
        <table>
          <thead>
            <tr><th>字段</th><th>类型</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>asset</code></td><td>string</td><td>必填</td><td>模板图片路径（相对于自动化包）</td></tr>
            <tr><td><code>threshold</code></td><td>number</td><td>0.9</td><td>匹配阈值，越高越严格</td></tr>
            <tr><td><code>method</code></td><td>string</td><td>'auto'</td><td>'template' = OpenCV 模板匹配；'color' = 颜色点匹配；'auto' = 自动选择</td></tr>
            <tr><td><code>alternatives</code></td><td>string[]</td><td>[]</td><td>额外模板图片，任一匹配即可</td></tr>
            <tr><td><code>scales</code></td><td>number[]</td><td>自动</td><td>缩放因子列表，不指定则自动检测</td></tr>
            <tr><td><code>mask</code></td><td>string</td><td>'auto'</td><td>'alpha' = 使用 PNG 透明通道；'none' = 无蒙版</td></tr>
            <tr><td><code>region</code></td><td>PersistedRegion</td><td>全画面</td><td>限制搜索区域，加速匹配</td></tr>
          </tbody>
        </table>

        <h3>TextLocator（文字定位）</h3>
        <p>通过 OCR 识别文字：</p>
        <pre>{`{
  kind: 'text',
  text: '开始游戏',
  match: 'contains',        // 'exact' | 'contains' | 'normalized'
  minConfidence: 0.8,       // OCR 置信度阈值
  region: { unit: 'ratio', x: 0, y: 0, width: 10000, height: 5000 },
  languageHint: 'zh-CN',    // 语言提示
}`}</pre>

        <h3>FirstOfLocator（回退链）</h3>
        <p>按顺序尝试多个定位器，返回第一个成功的：</p>
        <pre>{`{
  kind: 'firstOf',
  locators: [
    { kind: 'image', asset: 'btn-v2.png' },   // 先找新版按钮
    { kind: 'image', asset: 'btn-v1.png' },   // 找不到则找旧版
    { kind: 'text', text: '确定', match: 'exact', minConfidence: 0.7 },  // 都找不到则 OCR
  ]
}`}</pre>
      </>
    ),
  },

  // ── 6. bao.input ──────────────────────────────────────────
  {
    id: 'bao.input',
    title: 'bao.input',
    content: (
      <>
        <h2>bao.input</h2>
        <p>鼠标和键盘输入操作。<strong>需要 <code>input</code> 权限。</strong></p>

        <h3>bao.input.click(target, options?)</h3>
        <p>点击目标位置。坐标目标立即响应；图像/OCR 目标会轮询等待出现。</p>
        <div className="api-signature">
          click(target: TargetRef, options?: {'{'} button?, count?, timeoutMs?, pollIntervalMs? {'}'}): Promise&lt;null&gt;
        </div>
        <table>
          <thead>
            <tr><th>参数</th><th>类型</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>target</code></td><td>TargetRef</td><td>必填</td><td>点击目标</td></tr>
            <tr><td><code>button</code></td><td>'primary' | 'middle' | 'secondary'</td><td>'primary'</td><td>鼠标按键</td></tr>
            <tr><td><code>count</code></td><td>number</td><td>1</td><td>点击次数（1–10）</td></tr>
            <tr><td><code>timeoutMs</code></td><td>number</td><td>10000</td><td>目标查找超时（ms）</td></tr>
            <tr><td><code>pollIntervalMs</code></td><td>number</td><td>0</td><td>重试间隔（ms）</td></tr>
          </tbody>
        </table>
        <pre>{`// 坐标点击
await bao.input.click({
  kind: 'coordinate',
  point: { unit: 'ratio', x: 5000, y: 5000 },
});

// 图像点击（轮询等待出现）
await bao.input.click(
  { kind: 'image', asset: 'start.png' },
  { timeoutMs: 15000, pollIntervalMs: 200 }
);

// 双击
await bao.input.click(
  { kind: 'image', asset: 'item.png' },
  { count: 2 }
);

// 右键点击
await bao.input.click(
  { kind: 'image', asset: 'target.png' },
  { button: 'secondary' }
);`}</pre>

        <h3>bao.input.move(target, options?)</h3>
        <p>移动鼠标到目标位置。</p>
        <div className="api-signature">
          move(target: TargetRef, options?: {'{'} durationMs?, timeoutMs?, pollIntervalMs? {'}'}): Promise&lt;null&gt;
        </div>
        <table>
          <thead>
            <tr><th>参数</th><th>类型</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>target</code></td><td>TargetRef</td><td>必填</td><td>目标位置</td></tr>
            <tr><td><code>durationMs</code></td><td>number</td><td>0</td><td>移动动画时长（0–60000ms）</td></tr>
            <tr><td><code>timeoutMs</code></td><td>number</td><td>10000</td><td>目标查找超时</td></tr>
          </tbody>
        </table>
        <pre>{`await bao.input.move(
  { kind: 'image', asset: 'cursor.png' },
  { durationMs: 500 }  // 0.5 秒平滑移动
);`}</pre>

        <h3>bao.input.drag(options)</h3>
        <p>从一个位置拖拽到另一个位置。from 和 to 在同一帧内解析，确保坐标一致。</p>
        <div className="api-signature">
          drag(options: {'{'} from: TargetRef, to: TargetRef, button?, durationMs?, timeoutMs? {'}'}): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.input.drag({
  from: { kind: 'image', asset: 'item.png' },
  to: { kind: 'coordinate', point: { unit: 'ratio', x: 8000, y: 5000 } },
  durationMs: 300,
});`}</pre>

        <h3>bao.input.keyPress(key, modifiers?)</h3>
        <p>按下键盘按键。</p>
        <div className="api-signature">
          keyPress(key: string, modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[]): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.input.keyPress('Enter');
await bao.input.keyPress('c', ['control']);  // Ctrl+C
await bao.input.keyPress('ArrowUp');         // 方向键`}</pre>

        <h3>bao.input.typeText(text, intervalMs?)</h3>
        <p>逐字符输入文本。</p>
        <div className="api-signature">
          typeText(text: string, intervalMs?: number): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.input.typeText('hello');
await bao.input.typeText('slow', 100);  // 每字符间隔 100ms`}</pre>

        <h3>bao.input.scroll(deltaX, deltaY)</h3>
        <p>滚动页面。</p>
        <div className="api-signature">
          scroll(deltaX: number, deltaY: number): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.input.scroll(0, -3);   // 向上滚动 3 行
await bao.input.scroll(5, 0);    // 向右滚动`}</pre>
      </>
    ),
  },

  // ── 7. bao.vision ──────────────────────────────────────────
  {
    id: 'bao.vision',
    title: 'bao.vision',
    content: (
      <>
        <h2>bao.vision</h2>
        <p>图像识别与视觉监控。<strong>需要 <code>vision</code> 权限。</strong></p>

        <h3>bao.vision.find(locator)</h3>
        <p>在当前画面中查找匹配的图像，返回最佳匹配或 null。</p>
        <div className="api-signature">
          find(locator: ImageLocator): Promise&lt;ScriptLocatedTarget | null&gt;
        </div>
        <table>
          <thead>
            <tr><th>返回字段</th><th>类型</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>point</code></td><td>{'{ x, y }'}</td><td>匹配中心的逻辑坐标</td></tr>
            <tr><td><code>bounds</code></td><td>{'{ x, y, width, height }'}</td><td>匹配区域的边界框</td></tr>
            <tr><td><code>ratioPoint</code></td><td>{'{ x, y }'}</td><td>匹配中心的比例坐标</td></tr>
            <tr><td><code>ratioBounds</code></td><td>{'{ x, y, width, height }'}</td><td>匹配区域的比例边界框</td></tr>
            <tr><td><code>confidence</code></td><td>number</td><td>匹配置信度 0–1</td></tr>
          </tbody>
        </table>
        <pre>{`const target = await bao.vision.find({
  kind: 'image',
  asset: 'assets/coin.png',
  threshold: 0.85,
});
if (target) {
  bao.log.info('找到金币，置信度: ' + target.confidence);
  await bao.input.click(target);
}`}</pre>

        <h3>bao.vision.exists(locator)</h3>
        <p>判断目标是否存在，不抛异常。</p>
        <div className="api-signature">
          exists(locator: LocatorSpec): Promise&lt;boolean&gt;
        </div>
        <pre>{`if (await bao.vision.exists({ kind: 'image', asset: 'enemy.png' })) {
  bao.log.info('发现敌人');
}`}</pre>

        <h3>bao.vision.waitForRegionChange(region, options?)</h3>
        <p>持续监控一个区域，等待像素变化（如动画、过场、状态切换）。</p>
        <div className="api-signature">
          waitForRegionChange(region: PersistedRegion, options?: {'{'} timeoutMs?, pollIntervalMs?, colorDelta?, minimumChangedPixels?, changedPixelRatio?, consecutiveFrames?, reference? {'}'}): Promise&lt;RegionChangeResult&gt;
        </div>
        <table>
          <thead>
            <tr><th>参数</th><th>类型</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>region</code></td><td>PersistedRegion</td><td>必填</td><td>监控区域</td></tr>
            <tr><td><code>timeoutMs</code></td><td>number</td><td>10000</td><td>最长等待时间</td></tr>
            <tr><td><code>pollIntervalMs</code></td><td>number</td><td>10</td><td>采样间隔</td></tr>
            <tr><td><code>colorDelta</code></td><td>number</td><td>32</td><td>单通道差异阈值（1–255）</td></tr>
            <tr><td><code>minimumChangedPixels</code></td><td>number</td><td>2</td><td>最少变化像素数</td></tr>
            <tr><td><code>changedPixelRatio</code></td><td>number</td><td>0.02</td><td>最少变化像素比例（0–1）</td></tr>
            <tr><td><code>consecutiveFrames</code></td><td>number</td><td>1</td><td>需要连续多少帧满足条件</td></tr>
            <tr><td><code>reference</code></td><td>'baseline' | 'previous'</td><td>'baseline'</td><td>对比基准：首帧 / 上一帧</td></tr>
          </tbody>
        </table>
        <pre>{`const 战斗区域 = {
  unit: 'ratio',
  x: 4500, y: 4500,
  width: 1000, height: 1000,
};
const result = await bao.vision.waitForRegionChange(
  战斗区域,
  {
    timeoutMs: 60000,       // 最多等 60 秒
    colorDelta: 40,         // 变化敏感度
    consecutiveFrames: 3,   // 连续 3 帧都变化才算
    reference: 'baseline',  // 与首帧对比
  }
);
if (result.changed) {
  bao.log.info('战斗结束，采样 ' + result.samples + ' 帧');
}`}</pre>

        <h3>bao.vision.waitForColor(region, colors, options?)</h3>
        <p>持续监控区域，等待指定颜色出现。</p>
        <div className="api-signature">
          waitForColor(region: PersistedRegion, colors: readonly string[], options?: {'{'} timeoutMs?, pollIntervalMs?, tolerance?, minimumMatchingPixels?, consecutiveFrames? {'}'}): Promise&lt;RegionColorResult&gt;
        </div>
        <table>
          <thead>
            <tr><th>参数</th><th>类型</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>colors</code></td><td>string[]</td><td>必填</td><td>RGB 十六进制色值，如 <code>['#FBEC00', 'ff0000']</code>（1–16 个）</td></tr>
            <tr><td><code>tolerance</code></td><td>number</td><td>16</td><td>单通道容差（0–255）</td></tr>
            <tr><td><code>minimumMatchingPixels</code></td><td>number</td><td>1</td><td>最少匹配像素数</td></tr>
          </tbody>
        </table>
        <pre>{`const result = await bao.vision.waitForColor(
  { unit: 'ratio', x: 4900, y: 4900, width: 200, height: 200 },
  ['#FBEC00', 'fba400'],        // 等待金色/橙色
  { tolerance: 12, timeoutMs: 5000 }
);
if (result.found) {
  bao.log.info('颜色匹配，像素数: ' + result.matchingPixels);
}`}</pre>
      </>
    ),
  },

  // ── 8. bao.ocr ──────────────────────────────────────────
  {
    id: 'bao.ocr',
    title: 'bao.ocr',
    content: (
      <>
        <h2>bao.ocr</h2>
        <p>光学字符识别。<strong>需要 <code>ocr</code> 权限，且需要构建时包含 OCR 模块。</strong></p>

        <h3>bao.ocr.findText(locator)</h3>
        <p>在画面中查找指定文字，返回位置。</p>
        <div className="api-signature">
          findText(locator: TextLocator): Promise&lt;ScriptLocatedTarget | null&gt;
        </div>
        <pre>{`const btn = await bao.ocr.findText({
  kind: 'text',
  text: '开始游戏',
  match: 'exact',          // 精确匹配
  minConfidence: 0.8,
});
if (btn) {
  await bao.input.click(btn);
}`}</pre>

        <h3>bao.ocr.readText(region?, minConfidence?)</h3>
        <p>读取区域中所有文字，拼接为字符串。</p>
        <div className="api-signature">
          readText(region?: PersistedRegion, minConfidence?: number): Promise&lt;string&gt;
        </div>
        <pre>{`const text = await bao.ocr.readText(
  { unit: 'ratio', x: 1000, y: 500, width: 3000, height: 500 }
);
bao.log.info('识别结果: ' + text);`}</pre>

        <h3>bao.ocr.readNumber(region?, locale?)</h3>
        <p>读取区域中的数字，解析为数值。找不到数字则抛异常。</p>
        <div className="api-signature">
          readNumber(region?: PersistedRegion, locale?: string): Promise&lt;number&gt;
        </div>
        <pre>{`const hp = await bao.ocr.readNumber(
  { unit: 'ratio', x: 500, y: 100, width: 1500, height: 300 }
);
bao.log.info('生命值: ' + hp);`}</pre>
      </>
    ),
  },

  // ── 9. bao.page ──────────────────────────────────────────
  {
    id: 'bao.page',
    title: 'bao.page',
    content: (
      <>
        <h2>bao.page</h2>
        <p>页面导航与信息读取。</p>

        <h3>bao.page.url()</h3>
        <p>获取当前页面 URL。<strong>需要 <code>page.read</code> 权限。</strong></p>
        <div className="api-signature">
          url(): Promise&lt;string&gt;
        </div>
        <pre>{`const url = await bao.page.url();
bao.log.info('当前页面: ' + url);`}</pre>

        <h3>bao.page.navigate(url)</h3>
        <p>导航到指定 URL。<strong>需要 <code>page.navigate</code> 权限。</strong></p>
        <div className="api-signature">
          navigate(url: string): Promise&lt;null&gt;
        </div>
        <p>只允许 <code>http://</code> 和 <code>https://</code> 协议。</p>
        <pre>{`await bao.page.navigate('https://example.com/game');
await bao.time.sleep(3000);  // 等待加载`}</pre>

        <h3>bao.page.reload()</h3>
        <p>刷新当前页面。<strong>需要 <code>page.navigate</code> 权限。</strong></p>
        <div className="api-signature">
          reload(): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.page.reload();
await bao.time.sleep(2000);`}</pre>
      </>
    ),
  },

  // ── 10. bao.time ──────────────────────────────────────────
  {
    id: 'bao.time',
    title: 'bao.time',
    content: (
      <>
        <h2>bao.time</h2>
        <p>计时与等待。<strong>不需要任何权限</strong>，但受预算限制。</p>

        <h3>bao.time.sleep(durationMs)</h3>
        <p>暂停脚本执行。</p>
        <div className="api-signature">
          sleep(durationMs: number): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.time.sleep(1000);  // 等待 1 秒
await bao.time.sleep(500);   // 等待 0.5 秒`}</pre>
        <p>可通过中止信号取消，范围 0–3,600,000ms。</p>

        <h3>bao.time.now()</h3>
        <p>获取当前高精度时间戳（毫秒），用于计时。</p>
        <div className="api-signature">
          now(): Promise&lt;number&gt;
        </div>
        <pre>{`const start = await bao.time.now();
// ... 执行一些操作 ...
const elapsed = await bao.time.now() - start;
bao.log.info('耗时: ' + elapsed + 'ms');`}</pre>
      </>
    ),
  },

  // ── 11. bao.log ──────────────────────────────────────────
  {
    id: 'bao.log',
    title: 'bao.log',
    content: (
      <>
        <h2>bao.log</h2>
        <p>日志输出到状态栏和诊断日志。<strong>需要 <code>log</code> 权限。</strong></p>

        <div className="api-signature">
          debug(message: string): Promise&lt;null&gt;<br/>
          info(message: string): Promise&lt;null&gt;<br/>
          warn(message: string): Promise&lt;null&gt;<br/>
          error(message: string): Promise&lt;null&gt;
        </div>
        <pre>{`bao.log.debug('调试信息');
bao.log.info('操作完成');
bao.log.warn('即将超时');
bao.log.error('识别失败');`}</pre>
        <p>所有方法接受空字符串，返回 null。</p>
      </>
    ),
  },

  // ── 12. bao.notify ──────────────────────────────────────
  {
    id: 'bao.notify',
    title: 'bao.notify',
    content: (
      <>
        <h2>bao.notify</h2>
        <p>弹出系统通知。<strong>需要 <code>notify</code> 权限。</strong></p>

        <h3>bao.notify.show(title, body?)</h3>
        <div className="api-signature">
          show(title: string, body?: string): Promise&lt;null&gt;
        </div>
        <pre>{`await bao.notify.show('任务完成', '所有日常已清空');
await bao.notify.show('检测到异常');`}</pre>
      </>
    ),
  },

  // ── 13. 预算与限制 ──────────────────────────────────────
  {
    id: '预算与限制',
    title: '预算与限制',
    content: (
      <>
        <h2>预算与限制</h2>
        <p>为防止脚本失控，平台对 API 调用施加以下限制：</p>

        <table>
          <thead>
            <tr><th>限制项</th><th>默认值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>maxCalls</code></td><td>10,000</td><td>单次运行最大 API 调用次数</td></tr>
            <tr><td><code>maxConcurrentCalls</code></td><td>8</td><td>同时进行的最大调用数</td></tr>
            <tr><td><code>deadlineMs</code></td><td>30,000</td><td>单次 API 调用超时（30 秒）</td></tr>
            <tr><td><code>timeoutMs</code></td><td>1,800,000</td><td>脚本最大运行时间（30 分钟）</td></tr>
            <tr><td><code>maxSourceBytes</code></td><td>524,288</td><td>脚本源码最大体积（512 KB）</td></tr>
            <tr><td><code>maxRequestBytes</code></td><td>65,536</td><td>单次请求最大体积（64 KB）</td></tr>
            <tr><td><code>maxResultBytes</code></td><td>262,144</td><td>单次返回值最大体积（256 KB）</td></tr>
            <tr><td><code>maxStringLength</code></td><td>10,000</td><td>字符串参数最大长度</td></tr>
            <tr><td><code>maxValueDepth</code></td><td>32</td><td>对象最大嵌套层级</td></tr>
          </tbody>
        </table>

        <h3>常见约束范围</h3>
        <table>
          <thead>
            <tr><th>参数</th><th>有效范围</th></tr>
          </thead>
          <tbody>
            <tr><td>click count</td><td>1–10（整数）</td></tr>
            <tr><td>image threshold</td><td>0–1</td></tr>
            <tr><td>timeout / pollInterval</td><td>0–3,600,000ms</td></tr>
            <tr><td>colorDelta</td><td>1–255</td></tr>
            <tr><td>tolerance</td><td>0–255</td></tr>
            <tr><td>consecutiveFrames</td><td>1–20</td></tr>
            <tr><td>colors 数组</td><td>1–16 个色值</td></tr>
            <tr><td>sleep duration</td><td>0–3,600,000ms</td></tr>
          </tbody>
        </table>
      </>
    ),
  },

  // ── 14. 错误码 ──────────────────────────────────────────
  {
    id: '错误码',
    title: '错误码',
    content: (
      <>
        <h2>错误码</h2>
        <p>当 API 调用失败时，平台会抛出带有以下错误码的异常：</p>

        <table>
          <thead>
            <tr><th>错误码</th><th>含义</th><th>常见原因</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>TOKEN_INVALID</code></td>
              <td>运行令牌无效</td>
              <td>脚本尝试使用错误的会话，通常发生在运行被中断后</td>
            </tr>
            <tr>
              <td><code>METHOD_INVALID</code></td>
              <td>方法不存在或不可用</td>
              <td>调用了不存在的 bao.* 方法，或该方法未被授权</td>
            </tr>
            <tr>
              <td><code>PERMISSION_DENIED</code></td>
              <td>权限不足</td>
              <td>调用了未授权的 API（如未勾选 input 权限却调用 bao.input.click）</td>
            </tr>
            <tr>
              <td><code>PAYLOAD_INVALID</code></td>
              <td>参数校验失败</td>
              <td>传入了无效参数（如超出范围的数值、缺少必填字段）</td>
            </tr>
            <tr>
              <td><code>BUDGET_EXCEEDED</code></td>
              <td>预算超限</td>
              <td>调用次数超过 maxCalls，或并发数超过 maxConcurrentCalls</td>
            </tr>
            <tr>
              <td><code>BROKER_CLOSED</code></td>
              <td>运行已关闭</td>
              <td>脚本运行已被用户或系统终止</td>
            </tr>
            <tr>
              <td><code>CALL_FAILED</code></td>
              <td>调用失败</td>
              <td>宿主端抛出异常或调用超时（超过 deadlineMs）</td>
            </tr>
          </tbody>
        </table>

        <h3>错误处理建议</h3>
        <pre>{`try {
  const target = await bao.vision.find({ kind: 'image', asset: 'rare.png' });
  await bao.input.click(target);
} catch (e) {
  if (e.code === 'BUDGET_EXCEEDED') {
    bao.log.error('调用次数已用完');
  } else if (e.code === 'CALL_FAILED') {
    bao.log.error('调用超时或失败');
  } else {
    bao.log.error('未知错误: ' + e.message);
  }
}`}</pre>
      </>
    ),
  },

  // ── 15. 完整示例 ──────────────────────────────────────────
  {
    id: '完整示例',
    title: '完整示例',
    content: (
      <>
        <h2>完整示例</h2>

        <h3>示例 1：自动签到</h3>
        <pre>{`// 等待页面加载
await bao.time.sleep(2000);

// 查找签到按钮
const btn = await bao.vision.find({
  kind: 'image',
  asset: 'assets/checkin-btn.png',
  threshold: 0.9,
});

if (btn) {
  await bao.input.click(btn);
  bao.log.info('已点击签到');
  await bao.time.sleep(1000);

  // 确认弹窗
  const confirm = await bao.ocr.findText({
    kind: 'text',
    text: '确定',
    match: 'exact',
    minConfidence: 0.8,
  });
  if (confirm) {
    await bao.input.click(confirm);
  }
} else {
  bao.log.warn('未找到签到按钮');
}`}</pre>

        <h3>示例 2：战斗循环</h3>
        <pre>{`const 战斗区域 = {
  unit: 'ratio',
  x: 4500, y: 4500,
  width: 1000, height: 1000,
};

for (let i = 0; i < 10; i++) {
  bao.log.info('第 ' + (i + 1) + ' 次战斗');

  // 点击开始战斗
  const startBtn = await bao.ocr.findText({
    kind: 'text',
    text: '开始战斗',
    match: 'contains',
    minConfidence: 0.7,
  });
  if (startBtn) {
    await bao.input.click(startBtn);
  }

  // 等待战斗结束（区域颜色变化）
  const result = await bao.vision.waitForRegionChange(
    战斗区域,
    { timeoutMs: 60000, consecutiveFrames: 5 }
  );

  if (result.changed) {
    bao.log.info('战斗结束');
    await bao.time.sleep(2000);
  } else {
    bao.log.error('战斗超时');
    break;
  }
}`}</pre>

        <h3>示例 3：读取并比较数值</h3>
        <pre>{`const 数值区域 = {
  unit: 'ratio',
  x: 500, y: 100,
  width: 2000, height: 400,
};

const oldValue = await bao.ocr.readNumber(数值区域);
bao.log.info('当前值: ' + oldValue);

// 等待数值变化
await bao.time.sleep(3000);

const newValue = await bao.ocr.readNumber(数值区域);
bao.log.info('新值: ' + newValue);

if (newValue > oldValue) {
  bao.log.info('增加了 ' + (newValue - oldValue));
} else if (newValue < oldValue) {
  bao.log.info('减少了 ' + (oldValue - newValue));
}`}</pre>

        <h3>示例 4：多步骤引导流程</h3>
        <pre>{`// Step 1: 等待并点击进入按钮
const enter = await bao.vision.find({
  kind: 'firstOf',
  locators: [
    { kind: 'image', asset: 'assets/enter-v2.png' },
    { kind: 'image', asset: 'assets/enter-v1.png' },
    { kind: 'text', text: '进入游戏', match: 'contains', minConfidence: 0.7 },
  ],
});
if (!enter) throw new Error('找不到进入按钮');
await bao.input.click(enter);
await bao.time.sleep(3000);

// Step 2: 等待加载完成（检测加载条消失）
const loadingRegion = {
  unit: 'ratio',
  x: 4000, y: 9000,
  width: 2000, height: 200,
};
await bao.vision.waitForColor(
  loadingRegion,
  ['#FFFFFF'],  // 等待白色加载条消失
  { tolerance: 10, timeoutMs: 30000 }
);

// Step 3: 点击主界面按钮
const mainBtn = await bao.vision.find({
  kind: 'image',
  asset: 'assets/main-menu.png',
});
if (mainBtn) {
  await bao.input.click(mainBtn);
  bao.log.info('引导流程完成');
}`}</pre>
      </>
    ),
  },
];
