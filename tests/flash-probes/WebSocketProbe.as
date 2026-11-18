package {
  import flash.utils.getDefinitionByName;
  import flash.events.EventDispatcher;
  import flash.events.Event;
  import flash.events.IOErrorEvent;

  // 用反射拿 flash.net.WebSocket，避免依赖 playerglobal 里是否有该声明。
  public class WebSocketProbe extends ProbeBase {
    override protected function run():void {
      var url:String = "ws://127.0.0.1:8098/";
      log("WS connect " + url);
      try {
        var cls:Class = getDefinitionByName("flash.net.WebSocket") as Class;
        if (cls == null) { log("WebSocket class NOT FOUND"); log("RESULT=FAIL"); return; }
        var ws:Object = new cls();
        var ed:EventDispatcher = ws as EventDispatcher;
        ed.addEventListener(Event.OPEN, function(e:Event):void { log("EVENT OPEN"); log("RESULT=OK"); });
        ed.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { log("IO_ERROR " + e.text); log("RESULT=FAIL"); });
        ed.addEventListener(Event.CLOSE, function(e:Event):void { log("EVENT CLOSE"); });
        ws.connect(url);
        log("connect() returned");
      } catch (e:Error) { log("EXCEPTION " + e.message); log("RESULT=FAIL"); }
    }
  }
}
