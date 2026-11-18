package {
  import com.adobe.utils.AGALMiniAssembler;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.Context3DProgramType;
  import flash.display3D.Context3DVertexBufferFormat;
  import flash.display3D.IndexBuffer3D;
import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
import flash.utils.ByteArray;
import flash.utils.getTimer;

  // 真正会上传 Program3D 并 drawTriangles 的 Stage3D 探针（用 Adobe 官方 AGALMiniAssembler）
  public class Stage3DDrawTri extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/";
    private var ctx:Context3D;

    public function Stage3DDrawTri() {
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
      var s3d:Stage3D = stage.stage3Ds[0];
      s3d.addEventListener(Event.CONTEXT3D_CREATE, onCtx);
      s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        rep("s3derr", e.text);
      });
      s3d.requestContext3D();
      rep("start", "drawtri");
    }

    private function onCtx(e:Event):void {
      ctx = Stage3D(e.target).context3D;
      if (ctx == null) { rep("ctx", "null"); return; }
      rep("driver", ctx.driverInfo);
      rep("ctx_ms", getTimer() + "ms");

      try { ctx.configureBackBuffer(800, 600, 0, false); rep("bb", "ok"); }
      catch (er:Error) { rep("bb", er.errorID + ":" + er.message); return; }

      var vb:VertexBuffer3D = null;
      try {
        vb = ctx.createVertexBuffer(3, 2);
        vb.uploadFromVector(Vector.<Number>([-1, -1, 3, -1, -1, 3]), 0, 3);
        rep("vb", "ok");
      } catch (e2:Error) { rep("vb", e2.errorID + ":" + e2.message); }

      var ib:IndexBuffer3D = null;
      try {
        ib = ctx.createIndexBuffer(3);
        ib.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        rep("ib", "ok");
      } catch (ei:Error) { rep("ib", ei.errorID + ":" + ei.message); }

      var prog:Program3D = null;
      try {
        var asm:AGALMiniAssembler = new AGALMiniAssembler();
        var v:ByteArray = asm.assemble(Context3DProgramType.VERTEX, "mov op, va0\n");
        var fr:ByteArray = asm.assemble(Context3DProgramType.FRAGMENT, "mov oc, fc0\n");
        rep("agal", "v=" + v.length + "B f=" + fr.length + "B");
        prog = ctx.createProgram();
        prog.upload(v, fr);
        rep("program", "uploaded");
      } catch (e3:Error) { rep("program", e3.errorID + ":" + e3.message); }

      try {
        ctx.setProgramConstantsFromVector(Context3DProgramType.FRAGMENT, 0,
                                          Vector.<Number>([1, 0, 0, 1]));
        ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_2);
        ctx.setProgram(prog);
        rep("setup", "ok");
      } catch (e4:Error) { rep("setup", e4.errorID + ":" + e4.message); }

      try { ctx.clear(0, 0, 0.2, 1); rep("clear", "ok"); }
      catch (e5:Error) { rep("clear", e5.errorID + ":" + e5.message); }

      try { ctx.drawTriangles(ib, 0, 1); rep("draw", "ok"); }
      catch (e6:Error) { rep("draw", e6.errorID + ":" + e6.message); }

      try { ctx.present(); rep("present", "ok@" + getTimer() + "ms"); }
      catch (e7:Error) { rep("present", e7.errorID + ":" + e7.message); }

      // 持续绘制：真实游戏每帧都 draw+present，Flash 的 Stage3D 命令可能按帧排队
      var frames:int = 0;
      var t0:int = getTimer();
      addEventListener(Event.ENTER_FRAME, function(e8:Event):void {
        frames++;
        try {
          ctx.clear(0, 0, 0.2, 1);
          ctx.drawTriangles(ib, 0, 1);
          ctx.present();
          if (frames == 5) rep("loop", "5 frames drawn");
          if (frames == 30) rep("fps1s", "30 frames");
          if (frames == 90) rep("fps3s", "90 frames");
          if (frames == 150) rep("timing", (getTimer() - t0) + "ms/150frames");
        } catch (e9:Error) {
          if (frames <= 2) rep("loop_exc", e9.errorID + ":" + e9.message);
        }
      });
    }
  }
}
