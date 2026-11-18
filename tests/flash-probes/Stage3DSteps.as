package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.Context3DRenderMode;
  import flash.display.BitmapData;
import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;

  // P3（无 AGAL 版）：逐步调用并上报错误码，用于判定 Flash 在哪一步 bail。
  public class Stage3DSteps extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/";
    private var ctx:Context3D;
    private var mode:String;

    public function Stage3DSteps() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void { run(); });
    }

    private function rep(tag:String, msg:String):void {
      try {
        var l:URLLoader = new URLLoader();
        l.load(new URLRequest(BASE + "rep?tag=" + encodeURIComponent(tag) +
                              "&msg=" + encodeURIComponent(msg)));
      } catch (e:Error) {}
    }

    private function run():void {
      mode = loaderInfo.parameters.mode || "auto";
      var s3d:Stage3D = stage.stage3Ds[0];
      s3d.addEventListener(Event.CONTEXT3D_CREATE, onCtx);
      s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        rep("s3derr", e.text);
      });
      if (mode == "software") {
        s3d.requestContext3D(Context3DRenderMode.SOFTWARE);
      } else {
        s3d.requestContext3D();
      }
      rep("start", "mode=" + mode);
    }

    private function onCtx(e:Event):void {
      ctx = Stage3D(e.target).context3D;
      if (ctx == null) { rep("ctx", "null"); return; }
      rep("driver", ctx.driverInfo + " mode=" + mode);
      rep("limits", "maxBackBuffer=" + ctx.maxBackBufferWidth + "x" + ctx.maxBackBufferHeight);

      try { ctx.configureBackBuffer(800, 600, 0, false); rep("bb", "ok"); }
      catch (er:Error) { rep("bb", er.errorID + ":" + er.message); return; }

      var vb:VertexBuffer3D = null;
      try {
        vb = ctx.createVertexBuffer(3, 2);
        vb.uploadFromVector(Vector.<Number>([-1, -1, 3, -1, -1, 3]), 0, 3);
        rep("vb", "ok");
      } catch (e2:Error) { rep("vb", e2.errorID + ":" + e2.message); }

      try { ctx.clear(0, 0, 0, 1); rep("clear", "ok"); }
      catch (e3:Error) { rep("clear", e3.errorID + ":" + e3.message); }

      // 没有 program 直接 draw，Flash 应给出错误码（用于确认 AS3 错误面可见）
      try { ctx.drawTriangles(null, 0, -1); rep("draw_noprog", "no-exception"); }
      catch (e4:Error) { rep("draw_noprog", e4.errorID + ":" + e4.message); }

      try { ctx.present(); rep("present", "ok"); }
      catch (e5:Error) { rep("present", e5.errorID + ":" + e5.message); }

      // 用 drawToBitmapData 把 Flash 视为"当前帧缓冲"的内容读回来
      try {
        var bmd:BitmapData = new BitmapData(800, 600, false, 0x000000);
        ctx.drawToBitmapData(bmd);
        var px:uint = bmd.getPixel(400, 300);
        rep("readback", "center=0x" + px.toString(16).toUpperCase());
      } catch (e6:Error) { rep("readback", e6.errorID + ":" + e6.message); }
    }
  }
}
