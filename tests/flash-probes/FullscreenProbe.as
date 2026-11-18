package {
  import flash.display.StageDisplayState;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.events.FullScreenEvent;

  public class FullscreenProbe extends ProbeBase {
    private var ticks:int = 0;

    override protected function run():void {
      log("displayState=" + stage.displayState);
      log("stageSize=" + stage.stageWidth + "x" + stage.stageHeight);
      log("click to request fullscreen...");
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        log("EVENT FULL_SCREEN fullScreen=" + e.fullScreen + " state=" + stage.displayState);
      });
      stage.addEventListener(MouseEvent.CLICK, function(e:MouseEvent):void {
        try {
          log("requesting FULL_SCREEN ...");
          stage.displayState = StageDisplayState.FULL_SCREEN;
          log("after set displayState=" + stage.displayState);
        } catch (err:Error) {
          log("EXCEPTION " + err.errorID + " " + err.message);
        }
      });
      // 每秒打一次当前状态与舞台尺寸，便于在截图里看到最终态
      stage.addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        ticks++;
        if (ticks % 30 != 0) return;
        log("state=" + stage.displayState + " stage=" + stage.stageWidth + "x" + stage.stageHeight);
        log("RESULT=" + (stage.displayState == StageDisplayState.FULL_SCREEN ? "OK" : "PENDING"));
      });
    }
  }
}
