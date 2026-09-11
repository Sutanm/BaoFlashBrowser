import * as Blockly from 'blockly';

/**
 * Wire the Blockly workspace disposal guard and return the effect's cleanup.
 *
 * `ResizeObserver.disconnect()` does not cancel a callback that is already
 * queued, so a resize callback can still be delivered after the effect tears
 * down. Once `workspace.dispose()` has run, touching the workspace is unsafe:
 * Blockly reports "Cannot read property 'FULL_BLOCK_FIELDS' of null" when it
 * re-measures a field whose cached renderer constants were invalidated by the
 * disposal pass (observed in the renderer console log). The same guard keeps a
 * late change event from serializing a disposed workspace over the saved draft.
 *
 * The ref is cleared BEFORE `dispose()` so code reaching the workspace through
 * it fails fast instead of observing a half-disposed instance.
 *
 * This lives in its own module so it can be unit tested without pulling in the
 * block schema (whose custom field extends `Blockly.Field`) or the editor. The
 * real symptom needs a field re-measure that jsdom cannot perform — Blockly
 * measures text through `HTMLCanvasElement.getContext('2d')` — so the teardown
 * contract is pinned directly rather than through a mounted editor.
 *
 * @param workspace workspace owned by the effect
 * @param host element observed for resizes
 * @param toolboxObserver observer watching the toolbox element for class changes
 * @param draftKey localStorage key receiving the serialized draft
 * @param onDirtyChange notified when a real edit happens; not called after cleanup
 * @param clearWorkspaceRef invoked with the ref still pointing at `workspace`
 * @returns the effect cleanup function
 */
export function automateTeardown(
  workspace: Blockly.WorkspaceSvg,
  host: HTMLElement,
  toolboxObserver: { disconnect(): void },
  draftKey: string,
  onDirtyChange: ((dirty: boolean) => void) | undefined,
  clearWorkspaceRef: () => void,
): () => void {
  let disposed = false;
  const resize = new ResizeObserver(() => {
    if (disposed) return;
    Blockly.svgResize(workspace);
  });
  resize.observe(host);
  const onChange = (event: Blockly.Events.Abstract): void => {
    if (disposed || event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) return;
    localStorage.setItem(draftKey, Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace)));
    onDirtyChange?.(true);
  };
  workspace.addChangeListener(onChange);
  return () => {
    disposed = true;
    resize.disconnect();
    toolboxObserver.disconnect();
    workspace.removeChangeListener(onChange);
    clearWorkspaceRef();
    workspace.dispose();
  };
}