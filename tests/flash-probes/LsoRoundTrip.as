package {
  import flash.net.SharedObject;

  // 读 → 自增 → 写。同一 SWF 连续跑两次，第二次应读到第一次的值。
  public class LsoRoundTrip extends ProbeBase {
    override protected function run():void {
      try {
        var so:SharedObject = SharedObject.getLocal("bao_probe");
        var before:int = (so.data.count is Number) ? int(so.data.count) : 0;
        log("LSO-READ count=" + before + " (0 = 首次或未持久化)");
        so.data.count = before + 1;
        so.data.last = "rt";
        var r:String = String(so.flush());
        log("LSO-WRITE count=" + so.data.count + " flush=" + r + " size=" + so.size);
        log("RESULT=" + ((r == "flushed") ? "OK" : "FAIL"));
      } catch (e:Error) {
        log("EXCEPTION " + e.errorID + " " + e.message);
        log("RESULT=FAIL");
      }
    }
  }
}
