package {
  import flash.display.Sprite;
  import flash.events.NetStatusEvent;
  import flash.media.Video;
  import flash.net.NetConnection;
  import flash.net.NetStream;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.text.TextField;
  import flash.utils.setTimeout;

  // 视频探针：验证 PPB_VideoDecoder（含软件解码回退路径）
  public class VideoProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;
    private var video:Video;
    private var ns:NetStream;
    private var frames:int = 0;

    public function VideoProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 60; tf.textColor = 0x00FF00;
      addChild(tf);
      setTimeout(run, 500);
    }

    private function run():void {
      try {
        var nc:NetConnection = new NetConnection();
        nc.addEventListener(NetStatusEvent.NET_STATUS, onNC);
        nc.connect(null);
        ns = new NetStream(nc);
        ns.addEventListener(NetStatusEvent.NET_STATUS, onNS);
        ns.client = { onMetaData: function(o:Object):void { rep("video", "META " + o.width + "x" + o.height + " " + o.duration); } };
        video = new Video(320, 240);
        video.y = 70;
        addChild(video);
        video.attachNetStream(ns);
        ns.play("testvid.mp4");
        rep("video", "play called");
        setTimeout(check, 3000);
        setTimeout(check, 6000);
      } catch (e:Error) {
        rep("video", "EXC " + e.errorID + " " + e.message);
      }
    }

    private function check():void {
      try {
        rep("video", "videoWidth=" + video.videoWidth + " videoHeight=" + video.videoHeight +
            " time=" + ns.time.toFixed(2));
      } catch (e:Error) { rep("video", "check EXC " + e.message); }
    }

    private function onNC(e:NetStatusEvent):void { rep("video", "NC " + e.info.code); }
    private function onNS(e:NetStatusEvent):void {
      rep("video", "NS " + e.info.code);
      if (e.info.code == "NetStream.Play.Stop") rep("video", "PLAY STOPPED");
    }

    private function rep(tag:String, msg:String):void {
      if (tf) tf.appendText(msg + "\n");
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
