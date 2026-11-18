package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.Context3DProgramType;
  import flash.display3D.Context3DVertexBufferFormat;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.utils.ByteArray;

  // P3：完整走一遍 Stage3D 绘制链路，每一步 try/catch 并把错误码发回本机 HTTP。
  public class Stage3DDraw extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/";
    private var ctx:Context3D;

    public function Stage3DDraw() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void { run(); });
    }

    private function rep(tag:String, msg:String):void {
      try {
        var l:URLLoader = new URLLoader();
        l.load(new URLRequest(BASE + "rep?tag=" + encodeURIComponent(tag) +
                              "&msg=" + encodeURIComponent(msg)));
      } catch (e:Error) {}
    }

    // AGAL: 顶点直接输出位置，片元输出常量色
    private function vertexAGAL():ByteArray {
      var b:ByteArray = new ByteArray();
      b.writeBytes(new <uint>[0x0011E00F /*mov op, va0 (va0 is 2 floats but mov op ok)*/ ], 0, 4);
      return b;
    }

    private function run():void {
      var s3d:Stage3D = stage.stage3Ds[0];
      s3d.addEventListener(Event.CONTEXT3D_CREATE, onCtx);
      s3d.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        rep("s3derr", e.text);
      });
      s3d.requestContext3D();
      rep("start", "run");
    }

    private function onCtx(e:Event):void {
      ctx = Stage3D(e.target).context3D;
      if (ctx == null) { rep("ctx", "null"); return; }
      rep("driver", ctx.driverInfo);

      try { ctx.configureBackBuffer(800, 600, 0, false); rep("bb", "ok"); }
      catch (err:Error) { rep("bb", err.errorID + ":" + err.message); return; }

      var vb:VertexBuffer3D = null;
      try {
        vb = ctx.createVertexBuffer(3, 2);
        vb.uploadFromVector(Vector.<Number>([-1, -1, 3, -1, -1, 3]), 0, 3);
        rep("vb", "ok");
      } catch (err2:Error) { rep("vb", err2.errorID + ":" + err2.message); }

      var prog:Program3D = null;
      try {
        prog = ctx.createProgram();
        ctx.setProgramConstantsFromVector(Context3DProgramType.FRAGMENT, 0,
                                          Vector.<Number>([1, 0, 0, 1]));
        rep("prog_create", "ok");

        var vAGAL:ByteArray = new ByteArray();
        // mov op, va0   => opcode 0x00, dst=op(0x0F<<... ) 具体编码见下方注释
        vAGAL.writeUnsignedInt(0x0011E00F);
        var fAGAL:ByteArray = new ByteArray();
        // mov oc, fc0
        fAGAL.writeUnsignedInt(0x0011E00F);
        vAGAL.position = 0; fAGAL.position = 0;
        prog.upload(vAGAL, fAGAL);
        rep("prog_upload", "ok");
      } catch (err3:Error) {
        rep("prog", err3.errorID + ":" + err3.message);
      }

      try { ctx.clear(0, 0, 0, 1); rep("clear", "ok"); }
      catch (err4:Error) { rep("clear", err4.errorID + ":" + err4.message); }

      try {
        ctx.setVertexBufferAt(0, vb, 0, Context3DVertexBufferFormat.FLOAT_2);
        ctx.setProgram(prog);
        rep("setup", "ok");
      } catch (err5:Error) { rep("setup", err5.errorID + ":" + err5.message); }

      try { ctx.drawTriangles(vb, 0, -1); rep("draw", "ok"); }
      catch (err6:Error) { rep("draw", err6.errorID + ":" + err6.message); }

      try { ctx.present(); rep("present", "ok"); }
      catch (err7:Error) { rep("present", err7.errorID + ":" + err7.message); }
    }
  }
}
