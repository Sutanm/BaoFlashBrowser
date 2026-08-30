import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Box,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FolderPlus,
  Image,
  ImagePlus,
  Play,
  Plus,
  Save,
  ScanSearch,
  Square,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
import type { JavaScriptAutomationCapability } from '@shared/automation/javascript-api';
import {
  collectAutomationImageGroups,
  decodeAutomationImageGroup,
} from '@shared/automation/image-groups';
import { useTabsStore } from '../../store/useTabsStore';
import AutomationBlocklyV2Editor, {
  type AutomationBlocklyV2EditorHandle,
} from './AutomationBlocklyV2Editor';
import './automation.css';

const CAPABILITIES: readonly JavaScriptAutomationCapability[] = [
  'input',
  'vision',
  'ocr',
  'page.read',
  'page.navigate',
  'notify',
  'log',
];
type Summary = Awaited<ReturnType<Window['electronAPI']['automationV3']['listPackages']>>[number];
type Detail = Awaited<ReturnType<Window['electronAPI']['automationV3']['getPackage']>>;
type Mode = 'blocks' | 'assets' | 'test' | 'script' | 'docs';
type Dialog = {
  kind: 'package' | 'script' | 'main';
  id: string;
  name: string;
  language: 'javascript' | 'typescript';
};

function shortAsset(asset: string): string {
  return asset.replace(/^assets\//u, '');
}

function AssetPreview({
  packageId,
  asset,
}: {
  packageId: string;
  asset: string;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ dataUrl: string; width: number; height: number }>();
  useEffect(() => {
    let live = true;
    void window.electronAPI.automationV3
      .assetPreview(packageId, asset)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [asset, packageId]);
  return (
    <>
      {preview ? <img src={preview.dataUrl} alt="" /> : <Image />}
      {preview && (
        <small>
          {preview.width} × {preview.height}
        </small>
      )}
    </>
  );
}

export default function AutomationPage(): React.JSX.Element {
  const api = window.electronAPI.automationV3;
  const editor = useRef<AutomationBlocklyV2EditorHandle>(null);
  const lastRunState = useRef<string>('idle');
  const tabs = useTabsStore((state) => state.tabs);
  const setActiveTabId = useTabsStore((state) => state.setActiveTabId);
  const [packages, setPackages] = useState<Summary[]>([]);
  const [detail, setDetail] = useState<Detail>();
  const [mode, setMode] = useState<Mode>('blocks');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [scriptSource, setScriptSource] = useState('');
  const [scriptLanguage, setScriptLanguage] = useState<'javascript' | 'typescript'>('typescript');
  const [permissions, setPermissions] = useState<JavaScriptAutomationCapability[]>(['log']);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [contextOpen, setContextOpen] = useState(true);
  const [testKind, setTestKind] = useState<'image' | 'ocr'>('image');
  const [testText, setTestText] = useState('购买');
  const [threshold, setThreshold] = useState(0.9);
  const [testScene, setTestScene] = useState<{
    token: string;
    name: string;
    dataUrl: string;
    sourceWidth: number;
    sourceHeight: number;
  }>();
  const [testResult, setTestResult] = useState<{
    dataUrl: string;
    sourceWidth: number;
    sourceHeight: number;
    matched: boolean;
    candidate?: {
      text?: string;
      x: number;
      y: number;
      width: number;
      height: number;
      score?: number;
    };
  }>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('Automation Core 已就绪');
  const [dialog, setDialog] = useState<Dialog>();
  const runnableTabs = tabs.filter((tab) => /^(https?|file):/iu.test(tab.url));
  const [targetTabId, setTargetTabId] = useState('');

  const showError = (error: unknown): void =>
    setNotice(error instanceof Error ? error.message : String(error));
  const applyDetail = useCallback((next: Detail, preserveMode = false): void => {
    setDetail(next);
    setSelectedAsset((current) =>
      next.assets.includes(current) ? current : (next.assets[0] ?? ''),
    );
    if (!preserveMode) {
      if (next.mainEntryId === 'workflow' && next.workflow) setMode('blocks');
      else {
        const script =
          next.scripts.find((entry) => entry.id === next.mainEntryId) ?? next.scripts[0];
        if (script) {
          setSelectedScriptId(script.id);
          setScriptName(script.name);
          setScriptSource(script.source);
          setScriptLanguage(script.language);
          setPermissions([...script.permissions]);
          setMode('script');
        }
      }
    }
    setDirty(false);
  }, []);
  const load = useCallback(
    async (packageId: string) => {
      if (!packageId) {
        setDetail(undefined);
        return;
      }
      applyDetail(await api.getPackage(packageId));
    },
    [api, applyDetail],
  );
  const refresh = useCallback(
    async (preferred?: string) => {
      const list = await api.listPackages();
      setPackages(list);
      const id =
        preferred && list.some((item) => item.packageId === preferred)
          ? preferred
          : (list[0]?.packageId ?? '');
      await load(id);
    },
    [api, load],
  );
  useEffect(() => {
    void refresh().catch(showError);
  }, []);
  useEffect(() => {
    setTargetTabId((current) => runnableTabs.some((tab) => tab.id === current)
      ? current
      : (runnableTabs.slice().sort((left, right) => right.createdAt - left.createdAt)[0]?.id ?? ''));
  }, [runnableTabs.map((tab) => `${tab.id}:${tab.url}`).join('|')]);
  useEffect(() => {
    let live = true;
    const poll = async (): Promise<void> => {
      try {
        const status = await api.status(); if (!live) return;
        const active = ['preparing', 'running', 'cancelling'].includes(status.state);
        setRunning(active);
        if (status.state !== lastRunState.current && ['completed', 'failed', 'cancelled'].includes(status.state)) {
          setNotice(status.message ?? (status.state === 'completed' ? '自动化脚本执行完成' : status.state === 'failed' ? '自动化脚本执行失败' : '已停止'));
        }
        lastRunState.current = status.state;
      } catch { /* Workbench teardown. */ }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 600);
    return () => { live = false; window.clearInterval(timer); };
  }, [api]);

  const selectScript = (id: string): void => {
    const script = detail?.scripts.find((entry) => entry.id === id);
    if (!script) return;
    setSelectedScriptId(id);
    setScriptName(script.name);
    setScriptSource(script.source);
    setScriptLanguage(script.language);
    setPermissions([...script.permissions]);
    setMode('script');
    setDirty(false);
  };
  const save = async (): Promise<boolean> => {
    if (!detail) return false;
    setBusy(true);
    try {
      if (mode === 'script')
        await api.upsertScript(
          detail.packageId,
          selectedScriptId,
          scriptName,
          scriptSource,
          [...permissions],
          scriptLanguage,
        );
      else if (mode === 'blocks' && detail.workflow) {
        const workflow = editor.current?.compile();
        if (!workflow) throw new Error('积木工作区尚未准备好');
        const validation = await api.validateWorkflow(workflow);
        if (!validation.valid)
          throw new Error(validation.issues.map((issue) => issue.message).join('\n'));
        await api.updateWorkflow(detail.packageId, validation.workflow);
        editor.current?.clearDraft();
      } else {
        setNotice('当前页面没有需要保存的内容');
        return true;
      }
      applyDetail(await api.getPackage(detail.packageId), true);
      setNotice('已保存');
      setDirty(false);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const runMain = async (): Promise<void> => {
    if (!detail || !targetTabId) {
      setNotice('请先打开一个游戏页面');
      return;
    }
    if (dirty && !await save()) return;
    setBusy(true);
    try {
      // The workbench is an internal tab and cannot itself be automated. Switch
      // to the explicitly selected page before reserving its BrowserView.
      setActiveTabId(targetTabId);
      await window.electronAPI.tab.activate(targetTabId);
      await api.start(detail.packageId, detail.mainEntryId, targetTabId);
      setRunning(true);
      setNotice(
        `正在运行主入口：${detail.mainEntryId === 'workflow' ? '主流程' : detail.mainEntryId}`,
      );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (): Promise<void> => {
    await api.cancel();
    setRunning(false);
    setNotice('已停止');
  };
  const importPackage = async (): Promise<void> => {
    setBusy(true);
    try {
      const opened = await api.openPackage();
      if (opened.canceled) return;
      const requested = [...new Set(opened.scripts.flatMap((entry) => entry.permissions))];
      if (
        requested.length &&
        !window.confirm(`这个自动化请求以下权限：\n\n${requested.join('\n')}\n\n是否允许并导入？`)
      )
        return;
      const approvals = Object.fromEntries(
        opened.scripts.map((entry) => [entry.id, entry.permissions]),
      );
      await api.installPackage(opened.token, opened.exists, approvals);
      await refresh(opened.packageId);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const importAssets = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.importAssets(detail.packageId);
      if (!result.canceled) {
        applyDetail(result.detail, true);
        setNotice('素材已导入');
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const importAssetFolder = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.importAssetFolder(detail.packageId);
      if (!result.canceled) {
        applyDetail(result.detail, true);
        setNotice('图片组文件夹已导入，可在图片积木中直接选择');
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const deleteAsset = async (): Promise<void> => {
    if (!detail || !selectedAsset || !window.confirm(`删除素材 ${shortAsset(selectedAsset)}？`))
      return;
    try {
      applyDetail(await api.deleteAsset(detail.packageId, selectedAsset), true);
    } catch (error) {
      showError(error);
    }
  };
  const openTestScene = async (): Promise<void> => {
    setBusy(true);
    try {
      const opened = await api.openTestScene();
      if (!opened.canceled) {
        setTestScene({
          token: opened.token,
          name: opened.name,
          dataUrl: opened.dataUrl,
          sourceWidth: opened.sourceWidth,
          sourceHeight: opened.sourceHeight,
        });
        setTestResult(undefined);
        setNotice(`已导入测试画面：${opened.name}`);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async (): Promise<void> => {
    if (!detail || !testScene) {
      setNotice('请先在中间导入一张待测试画面');
      return;
    }
    setBusy(true);
    try {
      if (testKind === 'image') {
        if (!selectedAsset) throw new Error('请先选择素材');
        const result = await api.testAssetOnScene(
          detail.packageId,
          testScene.token,
          selectedAsset,
          threshold,
          [0.75, 1, 1.25],
          'auto',
        );
        setTestResult({
          dataUrl: testScene.dataUrl,
          sourceWidth: testScene.sourceWidth,
          sourceHeight: testScene.sourceHeight,
          matched: result.matched,
          candidate: result.candidate ?? undefined,
        });
      } else {
        const result = await api.testTextOnScene(testScene.token, testText, 'contains', 0.5);
        setTestResult({
          dataUrl: testScene.dataUrl,
          sourceWidth: testScene.sourceWidth,
          sourceHeight: testScene.sourceHeight,
          matched: result.matched,
          candidate: result.candidate ?? undefined,
        });
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const createFromDialog = async (): Promise<void> => {
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === 'package') {
        await api.createPackage(dialog.id, dialog.name);
        setDialog(undefined);
        await refresh(dialog.id);
        return;
      }
      if (dialog.kind === 'main') {
        if (!detail) return;
        applyDetail((await api.setMainEntry(detail.packageId, dialog.id)) as Detail, true);
        setDialog(undefined);
        setNotice('主入口已更新');
        return;
      }
      if (!detail) return;
      const source =
        dialog.language === 'typescript'
          ? 'const [value] = input as [unknown];\nawait bao.log.info("脚本已启动");\nreturn value ?? null;\n'
          : 'const value = input[0];\nawait bao.log.info("脚本已启动");\nreturn value ?? null;\n';
      await api.upsertScript(
        detail.packageId,
        dialog.id,
        dialog.name,
        source,
        ['log'],
        dialog.language,
      );
      const next = await api.getPackage(detail.packageId);
      const created = next.scripts.find((entry) => entry.id === dialog.id);
      applyDetail(next, true);
      setDialog(undefined);
      if (created) {
        setSelectedScriptId(created.id);
        setScriptName(created.name);
        setScriptSource(created.source);
        setScriptLanguage(created.language);
        setPermissions([...created.permissions]);
        setMode('script');
        setDirty(false);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const scripts = detail?.scripts ?? [];
  const imageGroups = collectAutomationImageGroups(detail?.assets ?? []);
  const assetChoices = [
    ...imageGroups.map((group) => ({
      value: group.value,
      label: `图片组：${shortAsset(group.directory)}（${group.assets.length} 张）`,
    })),
    ...(detail?.assets ?? []).map((asset) => ({ value: asset, label: shortAsset(asset) })),
  ];
  const selectedImageGroup = decodeAutomationImageGroup(selectedAsset);
  const selectedPreviewAsset = selectedImageGroup?.[0] ?? selectedAsset;
  return (
    <div className="automation-workbench-v3">
      <header className="awb-header">
        <div className="awb-brand">
          <Workflow />
          <span>
            <strong>自动化工作台</strong>
            <small>Automation 2.0</small>
          </span>
        </div>
        <select value={detail?.packageId ?? ''} onChange={(event) => void load(event.target.value)}>
          {packages.map((item) => (
            <option key={item.packageId} value={item.packageId}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="awb-breadcrumb">
          {detail?.name ?? '未选择项目'} <b>/</b>{' '}
          {mode === 'blocks'
            ? '主流程'
            : mode === 'script'
              ? `${selectedScriptId}.${scriptLanguage === 'typescript' ? 'ts' : 'js'}`
              : mode === 'assets'
                ? '素材中心'
                : mode === 'test'
                  ? '测试中心'
                  : '接口文档'}
        </div>
        <select value={targetTabId} onChange={(event) => setTargetTabId(event.target.value)} title="运行页面">
          {runnableTabs.length ? runnableTabs.map((tab) => <option key={tab.id} value={tab.id}>运行于：{tab.title || tab.url}</option>) : <option value="">没有可运行页面</option>}
        </select>
        <div className="awb-actions">
          <button
            onClick={() =>
              setDialog({
                kind: 'package',
                id: `automation-${Date.now()}`,
                name: '新自动化',
                language: 'typescript',
              })
            }
          >
            <Plus />
            新建自动化包
          </button>
          <button onClick={() => void importPackage()}>
            <Download />
            导入
          </button>
          <button
            disabled={!detail}
            onClick={() => detail && void api.exportPackage(detail.packageId)}
          >
            <Upload />
            导出
          </button>
          {running ? (
            <button onClick={() => void stop()}>
              <Square />
              停止
            </button>
          ) : (
            <button onClick={() => void runMain()} disabled={!detail || busy}>
              <Play />
              运行主入口
            </button>
          )}
          <button className="primary" onClick={() => void save()} disabled={!detail || busy}>
            <Save />
            保存
          </button>
        </div>
      </header>
      <div className="awb-body">
        <aside className="awb-sidebar">
          <div className="awb-section-title">
            <strong>主入口</strong>
            <span>1</span>
          </div>
          {detail && (
            <button
              className={`awb-entry ${mode === (detail.mainEntryId === 'workflow' ? 'blocks' : 'script') ? 'selected' : ''}`}
              onClick={() =>
                detail.mainEntryId === 'workflow'
                  ? setMode('blocks')
                  : selectScript(detail.mainEntryId)
              }
            >
              {detail.mainEntryId === 'workflow' ? <Workflow /> : <FileCode2 />}
              <span>
                <strong>
                  {detail.mainEntryId === 'workflow'
                    ? '主流程'
                    : scripts.find((entry) => entry.id === detail.mainEntryId)?.name}
                </strong>
                <small>
                  {detail.mainEntryId === 'workflow'
                    ? 'Blockly · 点击运行时执行'
                    : '脚本 · 点击运行时执行'}
                </small>
              </span>
            </button>
          )}
          <button
            className="dashed"
            onClick={() =>
              detail &&
              setDialog({ kind: 'main', id: detail.mainEntryId, name: '', language: 'typescript' })
            }
          >
            更换主入口
          </button>
          <div className="awb-section-title">
            <strong>可复用脚本</strong>
            <span>{scripts.length}</span>
          </div>
          {scripts.map((script) => (
            <button
              key={script.id}
              className={`awb-entry ${mode === 'script' && selectedScriptId === script.id ? 'selected' : ''}`}
              onClick={() => selectScript(script.id)}
            >
              <span className={`language ${script.language === 'typescript' ? 'ts' : 'js'}`}>
                {script.language === 'typescript' ? 'TS' : 'JS'}
              </span>
              <span>
                <strong>{script.name}</strong>
                <small>{shortAsset(script.path)} · 可被积木调用</small>
              </span>
            </button>
          ))}
          {detail && (
            <button
              className="dashed"
              onClick={() =>
                setDialog({
                  kind: 'script',
                  id: `script-${scripts.length + 1}`,
                  name: '新脚本',
                  language: 'typescript',
                })
              }
            >
              <Plus />
              新建 JS / TS 脚本
            </button>
          )}
          <div className="awb-section-title">
            <strong>资源工具</strong>
          </div>
          <nav>
            <button className={mode === 'assets' ? 'active' : ''} onClick={() => setMode('assets')}>
              <Box />
              管理素材
            </button>
            <button className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>
              <ScanSearch />
              测试识别
            </button>
            <button className={mode === 'docs' ? 'active' : ''} onClick={() => setMode('docs')}>
              <BookOpen />
              接口文档
            </button>
          </nav>
          <p className="awb-help">
            <b>一个默认主入口</b>脚本既可以独立设为主入口，也可以被 Blockly 的“运行脚本”积木调用。
          </p>
        </aside>
        <main className="awb-main">
          {detail?.workflow && mode === 'blocks' && (
            <div className={`awb-blocks ${contextOpen ? '' : 'context-closed'}`}>
              <AutomationBlocklyV2Editor
                ref={editor}
                key={`${detail.packageId}:${scripts.map((entry) => entry.id).join(',')}`}
                packageId={detail.packageId}
                workflowId={detail.workflow.id}
                workflowName={detail.workflow.name}
                initialDocument={detail.workflow}
                assets={detail.assets.map(shortAsset)}
                scripts={scripts.map((entry) => entry.id)}
                onDirtyChange={setDirty}
              />
              <aside className="awb-context">
                <button className="collapse" onClick={() => setContextOpen((value) => !value)}>
                  {contextOpen ? <ChevronRight /> : <ChevronLeft />}
                </button>
                {contextOpen && (
                  <>
                    <div className="context-head">
                      <strong>素材托盘</strong>
                      <button onClick={() => void importAssets()}>
                        <FolderPlus />
                        导入
                      </button>
                      <small>点击素材可用于当前图片积木。</small>
                    </div>
                    <div className="awb-asset-grid compact">
                      {detail.assets.map((asset) => (
                        <button
                          key={asset}
                          className={selectedAsset === asset ? 'selected' : ''}
                          onClick={() => setSelectedAsset(asset)}
                        >
                          <AssetPreview packageId={detail.packageId} asset={asset} />
                          <b>{shortAsset(asset)}</b>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </aside>
            </div>
          )}
          {detail && mode === 'assets' && (
            <section className="awb-page">
              <div className="awb-page-head">
                <div>
                  <h2>素材中心</h2>
                  <p>
                    Blockly 与 JS/TS 共用当前包中的素材；一个文件夹内至少两张图片时自动成为图片组。
                  </p>
                </div>
                <div>
                  <button onClick={() => void importAssets()}>
                    <Image />
                    导入图片
                  </button>
                  <button className="primary" onClick={() => void importAssetFolder()}>
                    <FolderPlus />
                    导入图片组文件夹
                  </button>
                </div>
              </div>
              <div className="awb-assets-layout">
                <div className="awb-asset-grid">
                  {detail.assets.map((asset) => (
                    <button
                      key={asset}
                      className={selectedAsset === asset ? 'selected' : ''}
                      onClick={() => setSelectedAsset(asset)}
                    >
                      <AssetPreview packageId={detail.packageId} asset={asset} />
                      <b>{shortAsset(asset)}</b>
                    </button>
                  ))}
                  {!detail.assets.length && (
                    <div className="awb-empty">
                      <Image />
                      <b>暂无素材</b>
                      <span>导入 PNG、JPG、WebP 或 BMP 图片。</span>
                    </div>
                  )}
                </div>
                <aside className="awb-preview">
                  <h3>{selectedAsset ? shortAsset(selectedAsset) : '选择一个素材'}</h3>
                  {selectedAsset && (
                    <>
                      <div className="large-preview">
                        <AssetPreview packageId={detail.packageId} asset={selectedAsset} />
                      </div>
                      <button onClick={() => setMode('test')}>在场景中测试</button>
                      <button className="danger" onClick={() => void deleteAsset()}>
                        <Trash2 />
                        删除素材
                      </button>
                    </>
                  )}
                </aside>
              </div>
            </section>
          )}
          {detail && mode === 'test' && (
            <section className="awb-page">
              <div className="awb-page-head">
                <div>
                  <h2>测试中心</h2>
                  <p>导入一张待测试画面，离线验证单张图片、图片组和 OCR。</p>
                </div>
                <div className="awb-segment">
                  <button
                    className={testKind === 'image' ? 'active' : ''}
                    onClick={() => {
                      setTestKind('image');
                      setTestResult(undefined);
                    }}
                  >
                    图片对比
                  </button>
                  <button
                    className={testKind === 'ocr' ? 'active' : ''}
                    onClick={() => {
                      setTestKind('ocr');
                      setTestResult(undefined);
                    }}
                  >
                    文字识别 OCR
                  </button>
                </div>
              </div>
              <div className="awb-test-layout">
                <aside className="awb-test-controls">
                  {testKind === 'image' ? (
                    <>
                      <label>
                        选择图片或图片组
                        <select
                          value={selectedAsset}
                          onChange={(event) => {
                            setSelectedAsset(event.target.value);
                            setTestResult(undefined);
                          }}
                        >
                          {assetChoices.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        相似度 {Math.round(threshold * 100)}%
                        <input
                          type="range"
                          min="10"
                          max="100"
                          value={threshold * 100}
                          onChange={(event) => setThreshold(Number(event.target.value) / 100)}
                        />
                      </label>
                      {selectedPreviewAsset && (
                        <div className="awb-test-target-preview">
                          <div>
                            <AssetPreview
                              packageId={detail.packageId}
                              asset={selectedPreviewAsset}
                            />
                          </div>
                          <strong>
                            {selectedImageGroup
                              ? `图片组（${selectedImageGroup.length} 张）`
                              : '当前识别素材'}
                          </strong>
                          <span>
                            {selectedImageGroup
                              ? shortAsset(selectedImageGroup[0])
                              : shortAsset(selectedPreviewAsset)}
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <label>
                        要识别的文字
                        <input
                          value={testText}
                          onChange={(event) => setTestText(event.target.value)}
                        />
                      </label>
                      <div className="awb-test-target-preview text">
                        <ScanSearch />
                        <strong>OCR 识别内容</strong>
                        <span>{testText || '尚未输入文字'}</span>
                      </div>
                    </>
                  )}
                  <button
                    className="primary"
                    onClick={() => void runTest()}
                    disabled={busy || !testScene}
                  >
                    开始测试
                  </button>
                  {testResult && (
                    <div className={testResult.matched ? 'result good' : 'result bad'}>
                      <b>
                        {testResult.matched
                          ? '匹配成功'
                          : testResult.candidate
                            ? '最佳候选低于条件'
                            : '没有识别到候选'}
                      </b>
                      {testResult.candidate && (
                        <span>
                          {testResult.candidate.text
                            ? `“${testResult.candidate.text}” · `
                            : ''}
                          坐标 {Math.round(testResult.candidate.x)},
                          {Math.round(testResult.candidate.y)} ·{' '}
                          {Math.round((testResult.candidate.score ?? 0) * 100)}%
                        </span>
                      )}
                    </div>
                  )}
                </aside>
                <div className="awb-scene">
                  {testScene ? (
                    <>
                      <div
                        className="awb-scene-frame"
                        style={{
                          aspectRatio: `${testScene.sourceWidth} / ${testScene.sourceHeight}`,
                        }}
                      >
                        <img src={testScene.dataUrl} alt={testScene.name} />
                        {testResult?.candidate && (
                          <i
                            className={testResult.matched ? 'matched' : 'candidate'}
                            style={{
                              left: `${(testResult.candidate.x / testScene.sourceWidth) * 100}%`,
                              top: `${(testResult.candidate.y / testScene.sourceHeight) * 100}%`,
                              width: `${(testResult.candidate.width / testScene.sourceWidth) * 100}%`,
                              height: `${(testResult.candidate.height / testScene.sourceHeight) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                      <button
                        className="automation-test-scene-replace"
                        onClick={() => void openTestScene()}
                        disabled={busy}
                      >
                        <ImagePlus />
                        更换测试画面
                      </button>
                    </>
                  ) : (
                    <button
                      className="automation-test-scene-empty"
                      onClick={() => void openTestScene()}
                      disabled={busy}
                    >
                      <ImagePlus />
                      <strong>导入测试画面</strong>
                      <small>选择一张完整截图，在本地离线进行识图或 OCR 测试</small>
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          {detail && mode === 'script' && (
            <section className="awb-script">
              <div className="script-head">
                <div>
                  <h2>
                    {selectedScriptId}.{scriptLanguage === 'typescript' ? 'ts' : 'js'}
                  </h2>
                  <p>
                    {scriptLanguage === 'typescript' ? 'TypeScript · 保存时编译' : 'JavaScript'} ·
                    可被积木调用 · 沙箱运行
                  </p>
                </div>
                {detail.mainEntryId !== selectedScriptId && (
                  <button
                    onClick={() =>
                      void api
                        .setMainEntry(detail.packageId, selectedScriptId)
                        .then((value) => applyDetail(value as Detail, true))
                        .catch(showError)
                    }
                  >
                    设为主入口
                  </button>
                )}
                <button onClick={() => setMode('docs')}>
                  <BookOpen />
                  完整接口文档
                </button>
              </div>
              <div className="script-body">
                <div className="code-pane">
                  <div className="code-meta">
                    <input
                      value={scriptName}
                      onChange={(event) => {
                        setScriptName(event.target.value);
                        setDirty(true);
                      }}
                    />
                    <select
                      value={scriptLanguage}
                      onChange={(event) => {
                        setScriptLanguage(event.target.value as 'javascript' | 'typescript');
                        setDirty(true);
                      }}
                    >
                      <option value="typescript">TypeScript</option>
                      <option value="javascript">JavaScript</option>
                    </select>
                  </div>
                  <textarea
                    value={scriptSource}
                    onChange={(event) => {
                      setScriptSource(event.target.value);
                      setDirty(true);
                    }}
                    spellCheck={false}
                  />
                  <div className="permission-row">
                    <b>权限</b>
                    {CAPABILITIES.map((capability) => (
                      <label key={capability}>
                        <input
                          type="checkbox"
                          checked={permissions.includes(capability)}
                          onChange={(event) => {
                            setPermissions(
                              event.target.checked
                                ? [...permissions, capability]
                                : permissions.filter((item) => item !== capability),
                            );
                            setDirty(true);
                          }}
                        />
                        {capability}
                      </label>
                    ))}
                  </div>
                </div>
                <aside className="api-reference">
                  <h3>当前 API 快速参考</h3>
                  <p>完整文档不挤占编辑空间；这里显示常用签名。</p>
                  {[
                    'bao.input.click(target)',
                    'bao.vision.find(locator)',
                    'bao.ocr.readNumber(region)',
                    'bao.time.sleep(ms)',
                    'bao.log.info(message)',
                  ].map((item) => (
                    <button key={item}>{item}</button>
                  ))}
                </aside>
              </div>
            </section>
          )}
          {mode === 'docs' && (
            <section className="awb-docs">
              <aside>
                {[
                  '快速开始',
                  '权限与沙箱',
                  '坐标与游戏区域',
                  'Locator',
                  'bao.input',
                  'bao.vision',
                  'bao.ocr',
                  'bao.page',
                  'bao.time',
                  '完整示例',
                ].map((item) => (
                  <button key={item}>{item}</button>
                ))}
              </aside>
              <article>
                <h2>Automation API</h2>
                <p>
                  脚本在隔离沙箱中运行，只能通过 <code>bao.*</code> 使用经过授权的 Automation Core
                  能力。
                </p>
                <h3>bao.ocr.readNumber</h3>
                <pre>bao.ocr.readNumber(region?: PersistedRegion): Promise&lt;number&gt;</pre>
                <p>读取区域中的数字，结果可以直接参与 JavaScript/TypeScript 计算。</p>
                <h3>积木调用脚本</h3>
                <pre>{`// 脚本通过 input 接收“运行脚本”积木传入的参数\nconst [region] = input;\nreturn await bao.ocr.readNumber(region);`}</pre>
              </article>
            </section>
          )}
          {!detail && (
            <div className="awb-empty full">
              <Workflow />
              <h2>创建或导入自动化包</h2>
              <button
                onClick={() =>
                  setDialog({
                    kind: 'package',
                    id: `automation-${Date.now()}`,
                    name: '新自动化',
                    language: 'typescript',
                  })
                }
              >
                创建自动化
              </button>
            </div>
          )}
        </main>
      </div>
      <footer className="awb-status">
        <span className="ready">● {notice}</span>
        <span>
          主入口：
          {detail?.mainEntryId === 'workflow' ? 'Blockly 主流程' : (detail?.mainEntryId ?? '-')}
        </span>
        <span>素材：{detail?.assets.length ?? 0}</span>
        <span>{dirty ? '未保存' : '已保存'}</span>
      </footer>
      {dialog && (
        <div
          className="awb-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialog(undefined);
          }}
        >
          <form
            className="awb-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void createFromDialog();
            }}
          >
            <h2>
              {dialog.kind === 'package'
                ? '新建自动化包'
                : dialog.kind === 'script'
                  ? '新建可复用脚本'
                  : '选择主入口'}
            </h2>
            {dialog.kind === 'main' ? (
              <div className="main-entry-options">
                {[
                  ...(detail?.workflow
                    ? [{ id: 'workflow', name: 'Blockly 主流程', language: 'javascript' as const }]
                    : []),
                  ...scripts,
                ].map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={dialog.id === entry.id ? 'selected' : ''}
                    onClick={() => setDialog({ ...dialog, id: entry.id })}
                  >
                    {entry.id === 'workflow' ? <Workflow /> : <FileCode2 />}
                    <span>
                      <b>{entry.name}</b>
                      <small>{entry.id === 'workflow' ? '积木入口' : '脚本入口'}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <>
                <label>
                  ID
                  <input
                    autoFocus
                    value={dialog.id}
                    onChange={(event) => setDialog({ ...dialog, id: event.target.value })}
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                    required
                  />
                </label>
                <label>
                  名称
                  <input
                    value={dialog.name}
                    onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                    required
                  />
                </label>
                {dialog.kind === 'script' && (
                  <label>
                    语言
                    <select
                      value={dialog.language}
                      onChange={(event) =>
                        setDialog({
                          ...dialog,
                          language: event.target.value as 'javascript' | 'typescript',
                        })
                      }
                    >
                      <option value="typescript">TypeScript</option>
                      <option value="javascript">JavaScript</option>
                    </select>
                  </label>
                )}
              </>
            )}
            <div>
              <button type="button" onClick={() => setDialog(undefined)}>
                取消
              </button>
              <button className="primary" type="submit">
                {dialog.kind === 'main' ? '设为主入口' : '创建'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
