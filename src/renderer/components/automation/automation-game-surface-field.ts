import * as Blockly from 'blockly';
import { decodeGameSurfaceFeature, encodeGameSurfaceFeature, gameSurfaceFeatureLabel } from '../../../shared/automation/core';

export const GAME_SURFACE_FIELD = 'field_game_surface_feature_v3';

export class GameSurfaceFeatureField extends Blockly.Field<string> {
  EDITABLE = true;
  SERIALIZABLE = true;
  CURSOR = 'pointer';
  private readonly importLabel: string;

  constructor(value = '', importLabel = '点击导入游戏画面特征码') {
    super(value);
    this.importLabel = importLabel;
    this.maxDisplayLength = 34;
  }

  static fromJson(options: { value?: string; importLabel?: string }): GameSurfaceFeatureField {
    return new GameSurfaceFeatureField(options.value ?? '', options.importLabel);
  }

  protected getText_(): string {
    const value = this.getValue() || '';
    if (!value) return this.importLabel;
    try { return gameSurfaceFeatureLabel(decodeGameSurfaceFeature(value)); }
    catch { return '特征码无效（点击重新导入）'; }
  }

  isClickableInFlyout(_autoClosingFlyout: boolean): boolean { return true; }

  protected showEditor_(): void {
    void (async () => {
      try {
        const text = await window.electronAPI.automationV3.readClipboard();
        const normalized = encodeGameSurfaceFeature(decodeGameSurfaceFeature(text));
        this.setValue(normalized);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    })();
  }
}

try { Blockly.fieldRegistry.register(GAME_SURFACE_FIELD, GameSurfaceFeatureField); }
catch { /* Renderer hot reload can evaluate the module after registration. */ }
