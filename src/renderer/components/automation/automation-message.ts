import type { AutomationMessage } from '@shared/automation/types';
import type { TranslationFunctions } from '@renderer/i18n/i18n-types';

export function resolveAutomationMessage(message: AutomationMessage, LL: TranslationFunctions): string {
  const s = LL.automation.service;
  switch (message.key) {
    case 'raw':
      return message.params.text;
    case 'status.checkingAsset':
      return s.status.checkingAsset(message.params);
    case 'status.assetMatch':
      return s.status.assetMatch(message.params);
    case 'status.assetNoMatch':
      return s.status.assetNoMatch(message.params);
    case 'status.readyCheckFailed':
      return s.status.readyCheckFailed(message.params);
    case 'status.runFailed':
      return s.status.runFailed(message.params);
    case 'status.assetTestStopped':
      return s.status.assetTestStopped(message.params);
    case 'status.assetTestFailed':
      return s.status.assetTestFailed(message.params);
    case 'status.stepNext':
      return s.status.stepNext();
    case 'status.scriptCompleted':
      return s.status.scriptCompleted();
    case 'status.scriptStopped':
      return s.status.scriptStopped();
    case 'status.imageMatch':
      return s.status.imageMatch(message.params);
    case 'status.textMatch':
      return s.status.textMatch(message.params);
    case 'status.randomClickCoordinate':
      return s.status.randomClickCoordinate(message.params);
    case 'status.pausedNext':
      return s.status.pausedNext({ step: resolveAutomationMessage(message.params.step, LL) });
    case 'step.sequence':
      return s.step.sequence();
    case 'step.waitImage':
      return s.step.waitImage(message.params);
    case 'step.waitImageState':
      return s.step.waitImageState({ asset: message.params.asset, state: message.params.state === 'visible' ? s.state.visible() : s.state.hidden() });
    case 'step.clickImage':
      return s.step.clickImage(message.params);
    case 'step.clickCoordinate':
      return s.step.clickCoordinate(message.params);
    case 'step.waitTextState':
      return s.step.waitTextState({ text: message.params.text, state: message.params.state === 'visible' ? s.state.visible() : s.state.hidden() });
    case 'step.clickText':
      return s.step.clickText(message.params);
    case 'step.randomClickRegion':
      return s.step.randomClickRegion();
    case 'step.visionRegion':
      return s.step.visionRegion(message.params);
    case 'step.coordinateSpace':
      return s.step.coordinateSpace(message.params);
    case 'step.moveToImage':
      return s.step.moveToImage(message.params);
    case 'step.moveToCoordinate':
      return s.step.moveToCoordinate(message.params);
    case 'step.dragImage':
      return s.step.dragImage(message.params);
    case 'step.drag':
      return s.step.drag();
    case 'step.delay':
      return s.step.delay(message.params);
    case 'step.keyPress':
      return s.step.keyPress(message.params);
    case 'step.keyHoldUntilImage':
      return s.step.keyHoldUntilImage({ key: message.params.key, asset: message.params.asset, state: message.params.state === 'visible' ? s.state.visible() : s.state.hidden() });
    case 'step.textInput':
      return s.step.textInput();
    case 'step.scroll':
      return s.step.scroll();
    case 'step.navigate':
      return s.step.navigate();
    case 'step.reload':
      return s.step.reload();
    case 'step.log':
      return s.step.log(message.params);
    case 'step.notification':
      return s.step.notification(message.params);
    case 'step.ifImage':
      return s.step.ifImage(message.params);
    case 'step.ifCondition':
      return s.step.ifCondition();
    case 'step.waitCondition':
      return s.step.waitCondition();
    case 'step.waitConditionBranch':
      return s.step.waitConditionBranch();
    case 'step.end':
      return s.step.end({ result: message.params.result === 'success' ? s.step.endSuccess() : s.step.endFailure(), message: message.params.message });
    case 'step.repeat':
      return s.step.repeat(message.params);
    case 'step.repeatUntilImage':
      return s.step.repeatUntilImage(message.params);
    case 'step.repeatUntilCondition':
      return s.step.repeatUntilCondition();
    case 'step.forever':
      return s.step.forever();
    case 'step.breakLoop':
      return s.step.breakLoop();
    case 'step.positionCompare':
      return s.step.positionCompare(message.params);
    case 'step.positionRelation':
      return s.step.positionRelation();
  }
}
