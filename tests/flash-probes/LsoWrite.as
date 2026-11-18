package {
  import flash.net.SharedObject;

  public class LsoWrite extends ProbeBase {
    override protected function run():void {
      try {
        var so:SharedObject = SharedObject.getLocal("bao_probe");
        var n:int = (so.data.count is Number) ? int(so.data.count) : 0;
        n = n + 1;
        so.data.count = n;
        so.data.last = "written";
        var r:String = String(so.flush());
        log("LSO-WRITE count=" + n);
        log("flush=" + r);
        log("size=" + so.size);
        log("RESULT=" + ((n >= 1) ? "OK" : "FAIL"));
      } catch (e:Error) {
        log("LSO-WRITE EXCEPTION: " + e.message);
        log("RESULT=FAIL");
      }
    }
  }
}
