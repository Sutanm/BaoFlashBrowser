package {
  import flash.display.Sprite;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.text.TextField;
  import flash.utils.getDefinitionByName;
  import flash.utils.setTimeout;

  // DRM 探针 v3：依次调用 DRMManager 的方法，找哪个会触发 PPB_Flash_DRM
  public class DrmProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;
    private var mgr:Object;

    public function DrmProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 260; tf.textColor = 0x00FF00;
      addChild(tf);
      setTimeout(run, 500);
    }

    private function run():void {
      try {
        var cls:Class = getDefinitionByName("flash.net.drm.DRMManager") as Class;
        mgr = cls["getDRMManager"]();
        rep("drm", "mgr ok");

        // 1) resetDRMVouchers —— 最无害
        try { mgr["resetDRMVouchers"](); rep("drm", "resetDRMVouchers ok"); }
        catch (e:Error) { rep("drm", "resetDRMVouchers EXC " + e.errorID + " " + e.message); }

        // 2) loadVoucher(null, cb) —— 可能内部取 deviceID
        try { mgr["loadVoucher"](null, onVoucher); rep("drm", "loadVoucher called"); }
        catch (e:Error) { rep("drm", "loadVoucher EXC " + e.errorID + " " + e.message); }

        // 3) authenticate
        setTimeout(function():void {
          try { mgr["authenticate"](null, onAuth); rep("drm", "authenticate called"); }
          catch (e:Error) { rep("drm", "authenticate EXC " + e.errorID + " " + e.message); }
        }, 1500);
      } catch (e:Error) {
        rep("drm", "EXC " + e.errorID + " " + e.message);
      }
    }

    private function onVoucher(v:Object):void { rep("drm", "loadVoucher cb " + v); }
    private function onAuth(a:Object):void { rep("drm", "authenticate cb " + a); }

    private function rep(tag:String, msg:String):void {
      tf.appendText(msg + "\n");
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
