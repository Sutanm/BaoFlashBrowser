package {
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.SecurityErrorEvent;

  public class HttpProbe extends ProbeBase {
    override protected function run():void {
      var url:String = "http://127.0.0.1:8099/probe.txt";
      log("HTTP GET " + url);
      var l:URLLoader = new URLLoader();
      l.addEventListener(Event.COMPLETE, function(e:Event):void {
        log("COMPLETE bytes=" + String(l.data).length);
        log("BODY=" + String(l.data));
        log("RESULT=OK");
      });
      l.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
        log("IO_ERROR " + e.text);
        log("RESULT=FAIL");
      });
      l.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function(e:SecurityErrorEvent):void {
        log("SECURITY_ERROR " + e.text);
        log("RESULT=FAIL");
      });
      try { l.load(new URLRequest(url)); }
      catch (e:Error) { log("EXCEPTION " + e.message); log("RESULT=FAIL"); }
    }
  }
}
