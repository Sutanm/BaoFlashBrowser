package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.HTTPStatusEvent;
  import flash.events.IOErrorEvent;
  import flash.events.SecurityErrorEvent;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.net.URLRequestHeader;
import flash.net.URLRequestMethod;
  import flash.utils.setTimeout;

  // ORB 探针：从插件侧跨域拉一个 text/xml 配置（4399 CDN），验证是否被 ORB 拦掉
  public class OrbProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    private static const TARGET:String =
      "https://q.ms.huanlecdn.com/4399/cdn.123u.com/config/Authenticate.xml?v=889e0c96?1.01012910";

    public function OrbProbe() {
      setTimeout(function():void { run(); }, 400);
    }

    private function report(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }

    private function run():void {
      var l:URLLoader = new URLLoader();
      l.dataFormat = URLLoaderDataFormat.TEXT;
      l.addEventListener(Event.COMPLETE, function (e:Event):void {
        report("orb", "COMPLETE bytes=" + String(l.data).length);
      });
      l.addEventListener(HTTPStatusEvent.HTTP_STATUS, function (e:HTTPStatusEvent):void {
        report("orb", "HTTP_STATUS " + e.status);
      });
      l.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        report("orb", "IO_ERROR " + e.text);
      });
      l.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function (e:SecurityErrorEvent):void {
        report("orb", "SEC_ERROR " + e.text);
      });
      var req:URLRequest = new URLRequest(TARGET);
      req.method = URLRequestMethod.GET;
      try {
        l.load(req);
        report("orb", "load called");
      } catch (e2:Error) {
        report("orb", "EXC " + e2.errorID + ":" + e2.message);
      }
    }
  }
}
