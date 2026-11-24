package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.SecurityErrorEvent;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLRequest;

  // 跨源数据加载探针：从 loaderInfo.parameters.url 指定的地址读文本，
  // 把结果通过 ExternalInterface 回调给页面（成功带内容，失败带原因）。
  // 用于验证 broker 的 crossdomain / 重定向授权链路，不依赖任何第三方素材。
  public class NetLoad extends Sprite {
    private var target: String;

    public function NetLoad() {
      // Ruffle 下 loaderInfo.parameters 可能是空的：退回到从 SWF 自身 URL 的查询串里取。
      target = loaderInfo.parameters.url || parseParam(loaderInfo.loaderURL);
      report('start:' + target);
      var loader: URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (event: Event): void {
        report('ok:' + String(loader.data));
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (event: IOErrorEvent): void {
        report('ioerror');
      });
      loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function (event: SecurityErrorEvent): void {
        report('security');
      });
      try {
        loader.load(new URLRequest(target));
      } catch (error: *) {
        report('throw');
      }
    }

    // 返回值用 * 而不是 String：AS3 里 String 函数不能 return null。
    private function parseParam(url: String): * {
      var index: int = url ? url.indexOf('url=') : -1;
      if (index < 0) return null;
      var rest: String = url.substr(index + 4);
      var amp: int = rest.indexOf('&');
      if (amp >= 0) rest = rest.substr(0, amp);
      try {
        return decodeURIComponent(rest);
      } catch (error: *) {
        return rest;
      }
    }

    private function report(text: String): void {
      try {
        ExternalInterface.call('__netloadReport', text);
      } catch (error: *) {
        // Ruffle 下 ExternalInterface 支持有限，失败就只看 trace。
      }
    }
  }
}
