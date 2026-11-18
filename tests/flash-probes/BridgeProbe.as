package {
  import flash.display.Sprite;
  import flash.external.ExternalInterface;
  import flash.text.TextField;

  // 脚本桥探针：验证 JS <-> Flash 双向调用
  // 1) ExternalInterface.addCallback 让 JS 能调用 el.ping()
  // 2) ExternalInterface.call 让 Flash 主动调用 JS 的 window.__fromFlash
  public class BridgeProbe extends Sprite {
    public function BridgeProbe() {
      var tf:TextField = new TextField();
      tf.text = "BRIDGE PROBE";
      tf.textColor = 0x00FF00;
      tf.x = 10; tf.y = 10;
      addChild(tf);

      try {
        ExternalInterface.addCallback("ping", function():String { return "pong"; });
        tf.appendText("\naddCallback ok");
      } catch (e:Error) {
        tf.appendText("\naddCallback FAIL " + e.errorID);
      }

      try {
        var r:Object = ExternalInterface.call("window.__fromFlash", "hello-from-flash");
        tf.appendText("\ncall ok ret=" + r);
      } catch (e2:Error) {
        tf.appendText("\ncall FAIL " + e2.errorID);
      }

      try {
        tf.appendText("\navailable=" + ExternalInterface.available);
      } catch (e3:Error) {}
    }
  }
}
