package {
  import flash.display.Sprite;
  import flash.events.StatusEvent;
  import flash.net.LocalConnection;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.text.TextField;

  // LocalConnection 探针：验证 Flash↔Flash 本地通信（4399/7k7k 的加载器与医生工具都靠它）
  public class LocalConnProbe extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;
    private static const NAME:String = "_bao_lc_probe_1";

    public function LocalConnProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 260; tf.textColor = 0x00FF00;
      addChild(tf);
      try {
        rep("lc", "isSupported=" + LocalConnection.isSupported);
      } catch (e0:Error) { rep("lc", "isSupported EXC " + e0.message); }

      var recv:LocalConnection = new LocalConnection();
      recv.allowDomain("*");
      recv.client = { ping: function (v:String):void { rep("lc", "RECEIVED " + v); } };
      try {
        recv.connect(NAME);
        rep("lc", "connect ok");
      } catch (e1:Error) { rep("lc", "connect EXC " + e1.errorID + ":" + e1.message); }

      var send:LocalConnection = new LocalConnection();
      try {
        send.send(NAME, "ping", "hello");
        rep("lc", "send called");
      } catch (e2:Error) { rep("lc", "send EXC " + e2.errorID + ":" + e2.message); }


    }

    private function rep(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(BASE + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
