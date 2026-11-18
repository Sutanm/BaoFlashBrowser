package {
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;

  public class Stage3DProbe extends ProbeBase {
    override protected function run():void {
      log("Stage3D probe: requesting context...");
      try {
        var s3d:Stage3D = stage.stage3Ds[0];
        s3d.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
          log("EVENT CONTEXT3D_CREATE");
          var c:Context3D = s3d.context3D;
          if (c == null) { log("context3D is null"); log("RESULT=FAIL"); return; }
          try {
            c.configureBackBuffer(800, 600, 0, false);
            c.clear(1, 0, 0, 1);
            c.present();
            log("cleared to RED");
            log("driver=" + c.driverInfo);
            log("RESULT=OK");
          } catch (err:Error) { log("EXCEPTION(b) " + err.message); log("RESULT=FAIL"); }
        });
        s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
          log("CONTEXT3D ERROR " + e.text);
          log("RESULT=FAIL");
        });
        s3d.requestContext3D();
        log("requestContext3D called");
      } catch (e:Error) { log("EXCEPTION " + e.message); log("RESULT=FAIL"); }
    }
  }
}
