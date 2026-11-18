package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.KeyboardEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;

  // 键盘探针：把 keyCode 上报回本机，用于验证 PPAPI 键盘事件是否到达 Flash。
  public class KeyboardProbe extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/rep";
    private var sent:int = 0;

    public function KeyboardProbe() {
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void {
        stage.addEventListener(KeyboardEvent.KEY_DOWN, onDown);
        rep("ready", "keyboard probe");
      });
    }

    private function onDown(e:KeyboardEvent):void {
      if (sent++ > 30) return;
      rep("key", "code=" + e.keyCode + " char=" + e.charCode);
    }

    private function rep(tag:String, msg:String):void {
      try {
        var l:URLLoader = new URLLoader();
        l.load(new URLRequest(BASE + "?tag=" + encodeURIComponent(tag) +
                              "&msg=" + encodeURIComponent(msg)));
      } catch (e:Error) {}
    }
  }
}
