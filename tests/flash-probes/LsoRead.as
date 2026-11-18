package {
  import flash.net.SharedObject;

  public class LsoRead extends ProbeBase {
    override protected function run():void {
      try {
        var so:SharedObject = SharedObject.getLocal("bao_probe");
        var has:Boolean = (so.data.count != undefined);
        log("LSO-READ hasCount=" + has);
        log("count=" + so.data.count);
        log("last=" + so.data.last);
        log("RESULT=" + (has ? "OK" : "FAIL"));
      } catch (e:Error) {
        log("LSO-READ EXCEPTION: " + e.message);
        log("RESULT=FAIL");
      }
    }
  }
}
