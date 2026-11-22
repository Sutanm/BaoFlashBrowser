package {
  import flash.display.Sprite;
  import flash.events.KeyboardEvent;
  import flash.external.ExternalInterface;

  // 键盘输入探针（架构 §3 标签合同「键盘输入和 IME」的插件侧验收样本）。
  // 把收到的 keydown 通过 ExternalInterface 回调暴露给页面 JS，供冒烟测试读取，
  // 用来证明键盘事件真的进了 PPAPI 插件进程，而不只是到渲染进程。
  public class Keyprobe extends Sprite {
    private var events:Array = [];

    public function Keyprobe() {
      graphics.beginFill(0x1F5FAF);
      graphics.drawRect(0, 0, 400, 300);
      graphics.endFill();
      stage.focus = this;
      addEventListener(KeyboardEvent.KEY_DOWN, onKeyDown);
      stage.addEventListener(KeyboardEvent.KEY_DOWN, onKeyDown);
      if (ExternalInterface.available) {
        ExternalInterface.addCallback("keyProbe", dump);
      }
      trace("[keyprobe] ready");
    }

    private function onKeyDown(event:KeyboardEvent):void {
      if (events.length < 32) {
        events.push(event.keyCode + ":" + event.charCode);
      }
      trace("[keyprobe] keydown " + event.keyCode + " char " + event.charCode);
    }

    private function dump():String {
      return events.join(",");
    }
  }
}
