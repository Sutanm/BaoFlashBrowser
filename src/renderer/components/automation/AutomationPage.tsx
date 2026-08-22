import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Box, Braces, CheckCircle2, Copy, Download, FolderPlus, FolderSync, Image, PackageOpen, Plus, RefreshCw, Save, ScanSearch, Search, ShieldCheck, Trash2, Upload, Workflow } from 'lucide-react';
import type { AutomationWorkflow } from '@shared/automation/types';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import AutomationBlocklyEditor, { collectFolderImageGroups, type AutomationBlocklyEditorHandle } from './AutomationBlocklyEditor';
import AutomationAssetTestBench from './AutomationAssetTestBench';
import './automation.css';

type PackageSummary = { packageId: string; id: string; name: string; assets: string[] };
type AssetPreview = Awaited<ReturnType<Window['electronAPI']['automation']['getAssetPreview']>>;
type PackageDiagnostic = Awaited<ReturnType<Window['electronAPI']['automation']['diagnosePackage']>>;
type PackageImportPreview = Extract<Awaited<ReturnType<Window['electronAPI']['automation']['openPackage']>>, { canceled: false }>;

export default function AutomationPage(): React.JSX.Element {
  const api = window.electronAPI.automation;
  const { LL } = useI18nContext();
  const editorRef = useRef<AutomationBlocklyEditorHandle>(null);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [workflow, setWorkflow] = useState<AutomationWorkflow>();
  const [assets, setAssets] = useState<string[]>([]);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [assetPreview, setAssetPreview] = useState<AssetPreview>();
  const [assetReferenced, setAssetReferenced] = useState(false);
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<'blocks' | 'json' | 'test'>('blocks');
  const [notice, setNotice] = useState<string>(LL.automation.page.noticeInitial());
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<'create' | 'duplicate' | null>(null);
  const [draftId, setDraftId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [linkedFolder, setLinkedFolder] = useState<{ token: string; name: string }>();
  const [diagnostic, setDiagnostic] = useState<PackageDiagnostic>();
  const [importPreview, setImportPreview] = useState<PackageImportPreview>();

  const refreshPackages = useCallback(async (preferred?: string) => {
    const list = await api.listPackages();
    setPackages(list);
    const next = preferred && list.some((item) => item.packageId === preferred)
      ? preferred : list.some((item) => item.packageId === selectedId) ? selectedId : list[0]?.packageId ?? '';
    setSelectedId(next);
    return next;
  }, [api, selectedId]);

  const previewAsset = useCallback(async (packageId: string, asset: string) => {
    setSelectedAsset(asset);
    if (!packageId || !asset) { setAssetPreview(undefined); setAssetReferenced(false); return; }
    try {
      const [preview, references] = await Promise.all([api.getAssetPreview(packageId, asset), api.getAssetReferences(packageId, asset)]);
      setAssetPreview(preview); setAssetReferenced(references.referenced);
    }
    catch (error) { setAssetPreview(undefined); setNotice(error instanceof Error ? error.message : String(error)); }
  }, [api]);

  const loadPackage = useCallback(async (packageId: string) => {
    if (!packageId) { setWorkflow(undefined); setAssets([]); setSelectedAsset(''); setAssetPreview(undefined); setJson(''); return; }
    const detail = await api.getPackage(packageId);
    setWorkflow(detail.workflow); setAssets(detail.assets); setJson(JSON.stringify(detail.workflow, null, 2));
    await previewAsset(packageId, detail.assets[0] ?? '');
  }, [api, previewAsset]);

  useEffect(() => {
    void api.capabilities().then((status) => setEnabled(status.enabled));
    void refreshPackages().then(loadPackage).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  const importPackage = async (): Promise<void> => {
    if (dirty && !window.confirm(LL.automation.page.unsavedConfirm())) return;
    setBusy(true);
    try {
      const result = await api.openPackage({
        title: LL.automation.ipc.openPackageTitle(),
        filterName: LL.automation.ipc.openPackageFilter(),
      });
      if (result.canceled) return;
      setImportPreview(result);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const confirmPackageImport = async (): Promise<void> => {
    if (!importPreview) return;
    setBusy(true);
    try {
      const result = await api.installPackage(importPreview.token, importPreview.exists);
      await refreshPackages(result.packageId);
      await loadPackage(result.packageId);
      setDirty(false); setImportPreview(undefined);
      setNotice(LL.automation.page.noticeImported({ name: result.name }));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const openCreateDialog = (): void => {
    setDraftName(LL.automation.page.draftDefaultName()); setDraftId(`automation-${Date.now()}`); setScriptDialog('create');
  };

  const openDuplicateDialog = (): void => {
    if (!workflow || !selectedId) return;
    setDraftName(LL.automation.page.copySuffix({ name: workflow.name })); setDraftId(`${workflow.id}-copy`); setScriptDialog('duplicate');
  };

  const submitScriptDialog = async (): Promise<void> => {
    const id = draftId.trim(); const name = draftName.trim();
    if (!id || !name || !scriptDialog) return;
    setBusy(true);
    try {
      const created = scriptDialog === 'create'
        ? await api.createPackage(id, name)
        : await api.duplicatePackage(selectedId, id, name);
      await refreshPackages(created.packageId); await loadPackage(created.packageId);
      setNotice(scriptDialog === 'create' ? LL.automation.page.noticeCreated() : LL.automation.page.noticeDuplicated());
      setScriptDialog(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const deletePackage = async (): Promise<void> => {
    if (!workflow || !selectedId || !window.confirm(LL.automation.page.deletePackageConfirm({ name: workflow.name }))) return;
    setBusy(true);
    try {
      await api.deletePackage(selectedId);
      const next = await refreshPackages(); await loadPackage(next); setNotice(LL.automation.page.noticeDeleted());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const importAssets = async (): Promise<void> => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const result = await api.importAssets(selectedId, { title: LL.automation.ipc.selectAssetDir() });
      if (!result.canceled) {
        setAssets(result.assets ?? []);
        await refreshPackages(selectedId);
        await previewAsset(selectedId, result.assets?.[0] ?? '');
        setNotice(LL.automation.page.noticeMerged({ count: result.assets?.length ?? 0 }));
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const replaceAsset = async (): Promise<void> => {
    if (!selectedId || !selectedAsset) return;
    setBusy(true);
    try {
      const result = await api.replaceAsset(selectedId, selectedAsset, { title: LL.automation.ipc.replaceAssetTitle({ asset: selectedAsset }), filterName: LL.automation.ipc.imageAssetFilter() });
      if (!result.canceled) { setAssets(result.assets ?? []); await previewAsset(selectedId, selectedAsset); setNotice(LL.automation.page.noticeReplaced({ asset: selectedAsset })); }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const deleteAsset = async (): Promise<void> => {
    if (!selectedId || !selectedAsset || assetReferenced || !window.confirm(LL.automation.page.deleteAssetConfirm({ asset: selectedAsset }))) return;
    setBusy(true);
    try {
      const result = await api.deleteAsset(selectedId, selectedAsset);
      setAssets(result.assets); await refreshPackages(selectedId); await previewAsset(selectedId, result.assets[0] ?? '');
      setNotice(LL.automation.page.noticeAssetDeleted({ asset: selectedAsset }));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const selectPackage = async (packageId: string): Promise<void> => {
    if (dirty && !window.confirm(LL.automation.page.unsavedConfirm())) return;
    setSelectedId(packageId); setLinkedFolder(undefined); setAssetQuery(''); setDiagnostic(undefined); setBusy(true);
    try { await loadPackage(packageId); setDirty(false); setNotice(LL.automation.page.noticeLoaded()); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const saveBlocks = async (): Promise<boolean> => {
    if (!selectedId || !workflow) return false;
    setBusy(true);
    try {
      const compiled = editorRef.current?.compile();
      if (!compiled) throw new Error(LL.automation.blockly.workspaceNotReady());
      const next = { ...compiled, id: workflow.id, name: workflow.name, description: workflow.description };
      const validation = await api.validateWorkflow(next);
      if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
      const saved = await api.updateWorkflow(selectedId, validation.workflow);
      setWorkflow(saved); setJson(JSON.stringify(saved, null, 2));
      editorRef.current?.clearDraft(); setDirty(false);
      await refreshPackages(selectedId);
      setNotice(LL.automation.page.noticeSaved());
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };

  const linkAssetFolder = async (): Promise<void> => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const result = await api.linkAssetFolder(selectedId, { title: LL.automation.page.linkFolderTitle() });
      if (!result.canceled && result.token && result.name) {
        setLinkedFolder({ token: result.token, name: result.name });
        setNotice(LL.automation.page.folderLinked({ name: result.name, count: result.files?.length ?? 0 }));
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const syncAssetFolder = async (): Promise<void> => {
    if (!selectedId || !linkedFolder) return;
    setBusy(true);
    try {
      const result = await api.syncAssetFolder(selectedId, linkedFolder.token);
      setAssets(result.assets); await refreshPackages(selectedId);
      setNotice(LL.automation.page.folderSynced({ changed: result.addedOrUpdated.length, missing: result.missingFromFolder.length }));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const visibleAssets = assets.filter((asset) => asset.toLowerCase().includes(assetQuery.trim().toLowerCase()));
  const imageGroups = collectFolderImageGroups(assets);

  const diagnosePackage = async (): Promise<void> => {
    if (!selectedId) return; setBusy(true);
    try { setDiagnostic(await api.diagnosePackage(selectedId)); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault(); void saveBlocks();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [dirty, selectedId, workflow]);

  const applyJson = async (): Promise<void> => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(json);
      const validation = await api.validateWorkflow(parsed);
      if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
      const saved = await api.updateWorkflow(selectedId, validation.workflow);
      setWorkflow(saved); editorRef.current?.load(saved); editorRef.current?.clearDraft(); setDirty(false); setNotice(LL.automation.page.noticeJsonApplied());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const exportPackage = async (): Promise<void> => {
    if (!selectedId) return;
    if (!await saveBlocks()) return;
    const result = await api.exportPackage(selectedId, { title: LL.automation.ipc.exportPackageTitle(), filterName: LL.automation.ipc.openPackageFilter() });
    if (!result.canceled) setNotice(LL.automation.page.noticeExported({ path: result.filePath ?? LL.automation.page.noticeFallbackPath() }));
  };

  return (
    <div className="automation-page">
      <header className="automation-page-header">
        <div><h1><Workflow />{LL.automation.page.title()}</h1><p>{LL.automation.page.subtitle()}</p></div>
        <div className="automation-page-header-actions">
          <button type="button" onClick={openCreateDialog} disabled={busy}><Plus />{LL.automation.page.newScript()}</button>
          <button type="button" className="primary" onClick={() => void importPackage()} disabled={busy}><Download />{LL.automation.page.importPackage()}</button>
          <button type="button" onClick={() => void exportPackage()} disabled={busy || !selectedId} title={!selectedId ? LL.automation.page.exportRequiresSelection() : undefined}><Upload />{LL.automation.page.exportPackage()}</button>
          <button type="button" className="primary" onClick={() => void saveBlocks()} disabled={busy || !selectedId}><Save />{dirty ? LL.automation.page.saveDirty() : LL.automation.page.saveChanges()}</button>
        </div>
      </header>

      {!enabled && <div className="automation-page-warning">{LL.automation.page.warningDisabled()}</div>}

      <div className="automation-page-body">
        <aside className="automation-library">
          <div className="automation-library-title"><strong>{LL.automation.page.libraryTitle()}</strong><span>{packages.length}</span></div>
          {selectedId && <div className="automation-library-actions">
            <button type="button" onClick={openDuplicateDialog} disabled={busy} title={LL.automation.page.duplicateTitle()}><Copy />{LL.automation.page.duplicateTitle()}</button>
            <button type="button" className="danger" onClick={() => void deletePackage()} disabled={busy} title={LL.automation.page.deleteTitle()}><Trash2 />{LL.automation.page.deleteTitle()}</button>
          </div>}
          {packages.length ? packages.map((item) => (
            <button type="button" key={item.packageId} className={selectedId === item.packageId ? 'selected' : ''} onClick={() => void selectPackage(item.packageId)}>
              <PackageOpen /><span><strong>{item.name}</strong><small>{item.id} · {LL.automation.page.assetCount({ count: item.assets.length })}</small></span>
            </button>
          )) : <div className="automation-library-empty"><Box /><strong>{LL.automation.page.emptyLibrary()}</strong><span>{LL.automation.page.emptyLibraryHint()}</span></div>}
          {selectedId && <div className="automation-assets-list">
            <div className="automation-assets-heading"><Image /><strong>{LL.automation.page.assetsTitle()}</strong><span>{assets.length}</span><button type="button" onClick={() => void importAssets()} disabled={busy} title={LL.automation.page.mergeAssetsTitle()}><FolderPlus />{LL.automation.page.add()}</button></div>
            <label className="automation-asset-search"><Search /><input value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder={LL.automation.page.searchAssets()} /></label>
            <div className="automation-folder-link"><button type="button" onClick={() => void linkAssetFolder()} disabled={busy}><FolderSync />{linkedFolder ? linkedFolder.name : LL.automation.page.linkFolder()}</button>{linkedFolder && <button type="button" onClick={() => void syncAssetFolder()} disabled={busy}><RefreshCw />{LL.automation.page.syncFolder()}</button>}</div>
            {imageGroups.length > 0 && <div className="automation-image-groups"><strong>{LL.automation.page.imageGroups({ count: imageGroups.length })}</strong><small>{LL.automation.page.imageGroupsHint()}</small><div>{imageGroups.map((group) => <span key={group.folder} title={group.assets.join('\n')}>📚 {group.folder} · {group.assets.length}</span>)}</div></div>}
            {assets.length ? <ul>{visibleAssets.map((asset) => <li key={asset} title={asset} className={selectedAsset === asset ? 'selected' : ''}><button type="button" onClick={() => void previewAsset(selectedId, asset)}><small>{asset.includes('/') ? asset.slice(0, asset.lastIndexOf('/')) : LL.automation.page.rootFolder()}</small>{asset.split('/').pop()}</button></li>)}</ul> : <p>{LL.automation.page.noAssetsHint()}</p>}
            {assetPreview && <div className="automation-asset-preview">
              <img src={assetPreview.dataUrl} alt={assetPreview.asset} />
              <strong>{assetPreview.asset}</strong>
              <small>{assetPreview.width} × {assetPreview.height} · {(assetPreview.bytes / 1024).toFixed(1)} KB</small>
              <small className={assetReferenced ? 'referenced' : ''}>{assetReferenced ? LL.automation.page.assetReferenced() : LL.automation.page.assetUnreferenced()}</small>
              <div><button type="button" onClick={() => void replaceAsset()} disabled={busy}><RefreshCw />{LL.automation.page.replace()}</button><button type="button" className="danger" onClick={() => void deleteAsset()} disabled={busy || assetReferenced} title={assetReferenced ? LL.automation.page.removeAssetReferenceHint() : LL.automation.page.deleteAssetTitle()}><Trash2 />{LL.automation.page.deleteAssetTitle()}</button></div>
            </div>}
            <button type="button" className="automation-diagnostic-button" onClick={() => void diagnosePackage()} disabled={busy}><ShieldCheck />{LL.automation.page.diagnose()}</button>
            {diagnostic && <div className={`automation-diagnostic ${diagnostic.valid ? 'valid' : 'invalid'}`}>
              <strong>{diagnostic.valid ? LL.automation.page.diagnosticPassed() : LL.automation.page.diagnosticFailed()}</strong>
              <small>{LL.automation.page.diagnosticMetrics({ steps: diagnostic.stepCount, depth: diagnostic.maxDepth, assets: diagnostic.assetCount, size: (diagnostic.assetBytes / 1024 / 1024).toFixed(1) })}</small>
              {diagnostic.issues.map((issue) => <p className={`level-${issue.level}`} key={`${issue.code}:${issue.detail}`}>{issue.detail}</p>)}
            </div>}
          </div>}
        </aside>

        <main className="automation-editor-shell">
          {workflow ? <>
            <div className="automation-editor-meta">
              <label>{LL.automation.page.name()}<input value={workflow.name} onChange={(event) => { setWorkflow({ ...workflow, name: event.target.value }); setDirty(true); }} /></label>
              <label>{LL.automation.page.id()}<input value={workflow.id} disabled /></label>
              <label className="wide">{LL.automation.page.description()}<input value={workflow.description ?? ''} onChange={(event) => { setWorkflow({ ...workflow, description: event.target.value || undefined }); setDirty(true); }} /></label>
              <div className="automation-asset-summary"><strong>{assets.length}</strong><span>{LL.automation.page.assetCountLabel()}</span></div>
            </div>
            <div className="automation-editor-tabs">
              <button type="button" className={mode === 'blocks' ? 'active' : ''} onClick={() => setMode('blocks')}><Workflow />{LL.automation.page.blocksTab()}</button>
              <button type="button" className={mode === 'json' ? 'active' : ''} onClick={() => { setJson(JSON.stringify(workflow, null, 2)); setMode('json'); }}><Braces />{LL.automation.page.jsonTab()}</button>
              <button type="button" className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}><ScanSearch />{LL.automation.page.testBenchTab()}</button>
              <span className={dirty ? 'dirty' : ''}><CheckCircle2 />{dirty ? LL.automation.page.unsaved() : notice}</span>
            </div>
            <div className="automation-editor-content" hidden={mode !== 'blocks'}><AutomationBlocklyEditor key={selectedId} ref={editorRef} initialWorkflow={workflow} assets={assets} onDirtyChange={setDirty} /></div>
            <div className="automation-json-editor" hidden={mode !== 'json'}>
              <textarea value={json} onChange={(event) => { setJson(event.target.value); setDirty(true); }} spellCheck={false} />
              <button type="button" onClick={() => void applyJson()} disabled={busy}>{LL.automation.page.applyJson()}</button>
            </div>
            <div className="automation-test-editor" hidden={mode !== 'test'}><AutomationAssetTestBench packageId={selectedId} assets={assets} onAssetsChanged={(next) => { setAssets(next); void refreshPackages(selectedId); }} /></div>
          </> : <div className="automation-editor-empty"><Workflow /><h2>{LL.automation.page.emptyEditorTitle()}</h2><p>{LL.automation.page.emptyEditorHint()}</p></div>}
        </main>
      </div>

      {scriptDialog && <div className="automation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setScriptDialog(null); }}>
        <form className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title" onSubmit={(event) => { event.preventDefault(); void submitScriptDialog(); }}>
          <h2 id="automation-dialog-title">{scriptDialog === 'create' ? LL.automation.page.createDialogTitle() : LL.automation.page.duplicateDialogTitle()}</h2>
          <p>{LL.automation.page.dialogIdHint()}</p>
          <label>{LL.automation.page.name()}<input autoFocus value={draftName} maxLength={120} onChange={(event) => setDraftName(event.target.value)} /></label>
          <label>{LL.automation.page.id()}<input value={draftId} maxLength={96} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" onChange={(event) => setDraftId(event.target.value)} /></label>
          <div><button type="button" onClick={() => setScriptDialog(null)} disabled={busy}>{LL.automation.page.cancel()}</button><button type="submit" className="primary" disabled={busy || !draftName.trim() || !draftId.trim()}>{busy ? LL.automation.page.creating() : LL.automation.page.create()}</button></div>
        </form>
      </div>}
      {importPreview && <div className="automation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setImportPreview(undefined); }}>
        <section className="automation-dialog automation-import-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-import-title">
          <header>
            <span className="automation-import-icon"><Archive /></span>
            <div><h2 id="automation-import-title">{LL.automation.page.importConfirmTitle()}</h2><p>{LL.automation.page.importConfirmHint()}</p></div>
          </header>
          <div className="automation-import-file"><PackageOpen /><span><strong>{importPreview.fileName}</strong><small>{(importPreview.compressedBytes / 1024 / 1024).toFixed(2)} MB</small></span></div>
          <dl className="automation-import-summary">
            <div><dt>{LL.automation.page.name()}</dt><dd>{importPreview.name}</dd></div>
            <div><dt>{LL.automation.page.id()}</dt><dd><code>{importPreview.packageId}</code></dd></div>
            <div><dt>{LL.automation.page.importWorkflow()}</dt><dd className="valid"><CheckCircle2 />{LL.automation.page.importValidationPassed()}</dd></div>
            <div><dt>{LL.automation.page.assetsTitle()}</dt><dd>{LL.automation.page.importAssetSummary({ count: importPreview.assetCount, size: (importPreview.assetBytes / 1024 / 1024).toFixed(2) })}</dd></div>
          </dl>
          {importPreview.description && <p className="automation-import-description">{importPreview.description}</p>}
          <details className="automation-import-tree"><summary>{LL.automation.page.importDirectoryTitle()}</summary><pre>{['manifest.json', 'workflow.json', 'assets/', ...importPreview.assets.slice(0, 12).map((asset) => `  ${asset}`), ...(importPreview.assets.length > 12 ? [LL.automation.page.importMoreAssets({ count: importPreview.assets.length - 12 })] : [])].join('\n')}</pre></details>
          {importPreview.exists && <div className="automation-import-conflict" role="alert"><strong>{LL.automation.ipc.packageExistsTitle()}</strong><span>{LL.automation.ipc.packageExistsMessage()}</span></div>}
          <div className="automation-import-actions"><button type="button" onClick={() => setImportPreview(undefined)} disabled={busy}>{LL.automation.page.cancel()}</button><button type="button" className="primary" onClick={() => void confirmPackageImport()} disabled={busy}>{busy ? LL.automation.page.importing() : importPreview.exists ? LL.automation.ipc.replace() : LL.automation.page.importNow()}</button></div>
        </section>
      </div>}
    </div>
  );
}
