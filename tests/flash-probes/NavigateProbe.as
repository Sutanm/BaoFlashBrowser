package {
  import flash.net.navigateToURL;
  import flash.net.URLRequest;

  public class NavigateProbe extends ProbeBase {
    override protected function run():void {
      var url:String = "http://127.0.0.1:8099/probe.txt?from=flash";
      log("navigateToURL -> " + url);
      try {
        navigateToURL(new URLRequest(url), "_self");
        log("called navigateToURL");
        log("RESULT=CALLED");
      } catch (e:Error) {
        log("EXCEPTION " + e.errorID + " " + e.message);
        log("RESULT=FAIL");
      }
    }
  }
}
