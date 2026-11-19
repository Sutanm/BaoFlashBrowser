package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.system.System;
  import flash.text.TextField;
  import flash.utils.setTimeout;

  // 剪贴板探针 v2：区分"无用户手势"与"接口缺失"
  // 先自动试一次（预期 #2176），再等鼠标点击后试一次（若有手势则可能成功）
  public class ClipboardProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    public static const MARK:String = "BAO_CLIP_9x7";
    private var tf:TextField;
    private var triedAuto:Boolean = false;

    public function ClipboardProbe() {
      tf = new TextField();
      tf.width = 700; tf.height = 260; tf.textColor = 0x00FF00;
      tf.text = "click me";
      addChild(tf);
      setTimeout(autoTry, 500);
    }

    private function rep(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }

    private function autoTry():void {
      if (triedAuto) return;
      triedAuto = true;
      try {
        System.setClipboard(MARK + "_auto");
        rep("clip", "AUTO setClipboard ok");
      } catch (e:Error) {
        rep("clip", "AUTO setClipboard EXC " + e.errorID);
      }
      // 监听点击
      stage.addEventListener(MouseEvent.CLICK, onClick);
      rep("clip", "waiting for click");
    }

    private function onClick(e:MouseEvent):void {
      try {
        System.setClipboard(MARK + "_click");
        rep("clip", "CLICK setClipboard ok");
      } catch (e2:Error) {
        rep("clip", "CLICK setClipboard EXC " + e2.errorID);
      }
    }
  }
}
