package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;

  // 不绘制任何 2D 内容，只清屏成红色 —— 截图若为红色即证明 3D 输出可见。
  public class Stage3DVisual extends Sprite {
    public function Stage3DVisual() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void { run(); });
    }

    private function run():void {
      trace("Stage3DVisual: start");
      var s3d:Stage3D = stage.stage3Ds[0];
      s3d.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        trace("Stage3DVisual: CONTEXT3D_CREATE");
        var c:Context3D = s3d.context3D;
        if (c == null) { trace("Stage3DVisual: null context"); return; }
        c.configureBackBuffer(800, 600, 0, false);
        c.clear(1, 0, 0, 1);
        c.present();
        trace("Stage3DVisual: cleared red, driver=" + c.driverInfo);
      });
      s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        trace("Stage3DVisual: ERROR " + e.text);
      });
      s3d.requestContext3D();
      trace("Stage3DVisual: requestContext3D called");
    }
  }
}
