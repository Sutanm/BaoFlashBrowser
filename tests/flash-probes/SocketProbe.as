package {
  import flash.display.Sprite;
  import flash.events.DataEvent;
import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.ProgressEvent;
  import flash.events.SecurityErrorEvent;
  import flash.net.Socket;
  import flash.net.XMLSocket;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.text.TextField;
  import flash.utils.setTimeout;

  // Socket 探针：验证 PPB_TCPSocket / XMLSocket 是否可用（联网游戏的关键）
  public class SocketProbe extends Sprite {
    private static const BASE:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;
    private var host:String = "127.0.0.1";
    private var port:int = 18099;

    public function SocketProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 300;
      tf.textColor = 0x00FF00; addChild(tf);
      addEventListener(Event.ADDED_TO_STAGE, start);
    }

    private function log(s:String):void { tf.appendText(s + "\n"); rep("sock", s); }

    private function start(e:Event):void {
      setTimeout(function():void {
        // 1) 普通 Socket
        try {
          var s:Socket = new Socket();
          s.addEventListener(Event.CONNECT, function(ev:Event):void {
            log("socket CONNECT ok");
            try { s.writeUTFBytes("HELLO\n"); s.flush(); } catch (e:Error) { log("write fail " + e.message); }
          });
          s.addEventListener(IOErrorEvent.IO_ERROR, function(ev:IOErrorEvent):void { log("socket IO_ERROR " + ev.text); });
          s.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function(ev:SecurityErrorEvent):void { log("socket SEC_ERROR " + ev.text); });
          s.addEventListener(ProgressEvent.SOCKET_DATA, function(ev:ProgressEvent):void {
            var data:String = s.readUTFBytes(s.bytesAvailable);
            log("socket DATA " + data.replace(/\s+/g, " ").substr(0, 40));
            s.close();
          });
          s.connect(host, port);
          log("socket connect called");
        } catch (e2:Error) {
          log("socket EXC " + e2.errorID + ":" + e2.message);
        }

        // 2) XMLSocket
        try {
          var x:XMLSocket = new XMLSocket();
          x.addEventListener(Event.CONNECT, function(ev:Event):void { log("xmlsocket CONNECT ok"); try { x.send("<ping/>\n"); } catch (e:Error) {} });
          x.addEventListener(IOErrorEvent.IO_ERROR, function(ev:IOErrorEvent):void { log("xmlsocket IO_ERROR " + ev.text); });
          x.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function(ev:SecurityErrorEvent):void { log("xmlsocket SEC_ERROR " + ev.text); });
          x.addEventListener(DataEvent.DATA, function(ev:DataEvent):void { log("xmlsocket DATA " + String(ev.data).substr(0, 40)); });
          x.connect(host, port);
          log("xmlsocket connect called");
        } catch (e3:Error) {
          log("xmlsocket EXC " + e3.errorID + ":" + e3.message);
        }
      }, 500);
    }

    private function rep(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(BASE + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
