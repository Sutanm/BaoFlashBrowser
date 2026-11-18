package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.text.TextField;
  import flash.text.TextFormat;

  public class ProbeBase extends Sprite {
    protected var out:TextField;

    public function ProbeBase() {
      graphics.beginFill(0x101010);
      graphics.drawRect(0, 0, 800, 600);
      graphics.endFill();
      out = new TextField();
      out.width = 780; out.height = 560; out.x = 10; out.y = 10;
      out.multiline = true; out.wordWrap = true;
      out.background = true; out.backgroundColor = 0x000000;
      out.defaultTextFormat = new TextFormat("Consolas", 20, 0x00FF66);
      addChild(out);
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void { run(); });
    }

    protected function run():void {}

    protected function log(s:String):void {
      trace(s);
      out.appendText(s + "\n");
    }
  }
}
