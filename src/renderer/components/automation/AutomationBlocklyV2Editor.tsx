import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Blockly from 'blockly';
import enMessages from 'blockly/msg/en';
import zhHans from 'blockly/msg/zh-hans';
import { useI18nContext } from '../../i18n/i18n-react';
import { validateWorkflowDocument, type WorkflowDocumentV3 } from '../../../shared/automation/core';
import { AUTOMATION_V2_BLOCK_TYPES, automationV2Toolbox, registerAutomationV2Blocks } from './automation-blockly-v2-schema';
import { ensureAutomationV2Entry, workflowV3ToWorkspace, workspaceToWorkflowV3 } from './automation-blockly-v2-codec';

export type AutomationBlocklyV2EditorHandle = {
  compile(): WorkflowDocumentV3;
  load(document: WorkflowDocumentV3): void;
  clearDraft(): void;
};

export type AutomationBlocklyV2EditorProps = {
  readonly packageId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly initialDocument?: WorkflowDocumentV3;
  readonly assets?: readonly string[];
  readonly scripts?: readonly string[];
  readonly onDirtyChange?: (dirty: boolean) => void;
};

const NAMED_SURFACES = { game: { kind: 'visual', visualHint: 'container' } } as const;

/** Automation 2.0 editor. It never reads or writes Automation 1.x Blockly XML. */
const AutomationBlocklyV2Editor = forwardRef<AutomationBlocklyV2EditorHandle, AutomationBlocklyV2EditorProps>(function AutomationBlocklyV2Editor(
  { packageId, workflowId, workflowName, initialDocument, assets = [], scripts = [], onDirtyChange },
  ref,
) {
  const { locale } = useI18nContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const documentRef = useRef(initialDocument);
  documentRef.current = initialDocument;
  const draftKey = `baoauto:v3:draft:${packageId || workflowId}`;
  const assetFingerprint = [...new Set(assets)].sort().join('\n');
  const scriptFingerprint = [...new Set(scripts)].sort().join('\n');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const blockLocale = locale === 'en' ? 'en' : 'zh-CN';
    Blockly.setLocale(locale === 'en' ? enMessages : zhHans);
    registerAutomationV2Blocks(blockLocale, assetFingerprint ? assetFingerprint.split('\n') : [], scriptFingerprint ? scriptFingerprint.split('\n') : []);
    const workspace = Blockly.inject(host, {
      toolbox: automationV2Toolbox(blockLocale), trashcan: true, renderer: 'geras',
      zoom: { controls: true, wheel: true, startScale: .85, minScale: .45, maxScale: 1.4 },
      grid: { spacing: 20, length: 3, colour: '#d9e2ef', snap: true },
    });
    const categoryColours = ['#7656a8', '#58a966', '#67a153', '#5688a8', '#58a99f', '#ad587b', '#7b59ad', '#a56b36', '#9aaa52'];
    host.querySelectorAll('.blocklyToolboxCategory').forEach((category, index) => {
      category.querySelector<HTMLElement>('.blocklyTreeRow')?.style.setProperty('--bao-category-colour', categoryColours[index] ?? '#5677a8');
    });
    const syncFlyoutState = (): void => {
      host.classList.toggle('bao-flyout-collapsed', !host.querySelector('.blocklyTreeSelected'));
    };
    const toolboxElement = host.querySelector('.blocklyToolboxDiv');
    const toolboxObserver = new MutationObserver(syncFlyoutState);
    if (toolboxElement) toolboxObserver.observe(toolboxElement, { attributes: true, attributeFilter: ['class'], subtree: true });
    syncFlyoutState();
    workspaceRef.current = workspace;
    const stored = localStorage.getItem(draftKey);
    if (stored) {
      try { Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(stored), workspace); ensureAutomationV2Entry(workspace); onDirtyChange?.(true); }
      catch { localStorage.removeItem(draftKey); }
    } else if (documentRef.current) workflowV3ToWorkspace(workspace, documentRef.current);

    const resize = new ResizeObserver(() => Blockly.svgResize(workspace));
    resize.observe(host);
    const onChange = (event: Blockly.Events.Abstract): void => {
      if (event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) return;
      localStorage.setItem(draftKey, Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace)));
      onDirtyChange?.(true);
    };
    workspace.addChangeListener(onChange);
    return () => {
      resize.disconnect();
      toolboxObserver.disconnect();
      workspace.removeChangeListener(onChange);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, [assetFingerprint, draftKey, locale, onDirtyChange, scriptFingerprint]);

  useImperativeHandle(ref, () => ({
    compile: () => {
      const workspace = workspaceRef.current;
      if (!workspace) throw new Error('Automation 2.0 Blockly workspace is not ready');
      const document = workspaceToWorkflowV3(workspace, { id: workflowId, name: workflowName });
      validateWorkflowDocument(document, {}, NAMED_SURFACES);
      return document;
    },
    load: (document) => {
      documentRef.current = document;
      if (workspaceRef.current) workflowV3ToWorkspace(workspaceRef.current, document);
    },
    clearDraft: () => { localStorage.removeItem(draftKey); onDirtyChange?.(false); },
  }), [draftKey, onDirtyChange, workflowId, workflowName]);

  return <div ref={hostRef} className="automation-blockly-host" data-automation-version="2" data-block-types={AUTOMATION_V2_BLOCK_TYPES.join(' ')} />;
});

export default AutomationBlocklyV2Editor;
