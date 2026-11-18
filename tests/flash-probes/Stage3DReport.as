package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;

  // 把 Context3D 的 driverInfo 通过 URLLoader 发回本机 HTTP 服务，
  // 这样可以直接在 electron 的日志里读到 Flash 侧的判定结果。
  public class Stage3DReport extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/";

    public function Stage3DReport() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void { run(); });
    }

    private function report(tag:String, msg:String):void {
      try {
        var l:URLLoader = new URLLoader();
        l.load(new URLRequest(BASE + "rep?tag=" + encodeURIComponent(tag) +
                              "&msg=" + encodeURIComponent(msg)));
      } catch (e:Error) { trace("report failed " + e.message); }
    }

    private function run():void {
      var s3d:Stage3D = stage.stage3Ds[0];
      s3d.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        var c:Context3D = s3d.context3D;
        if (c == null) { report("ctx", "null"); return; }
        report("driver", c.driverInfo);
        try {
          c.configureBackBuffer(800, 600, 0, false);
          c.clear(1, 0, 0, 1);
          c.present();
          report("ok", "cleared-red");
        } catch (err:Error) {
          report("exc", err.errorID + ":" + err.message);
        }
      });
      s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        report("err", e.text);
      });
      s3d.requestContext3D();
      report("start", "requesting");
    }
  }
}
