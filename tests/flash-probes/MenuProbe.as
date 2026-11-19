package {
  import flash.display.Sprite;
  import flash.events.ContextMenuEvent;
  import flash.events.MouseEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.ui.ContextMenu;
  import flash.ui.ContextMenuItem;
  import flash.text.TextField;
  import flash.utils.setTimeout;

  // v2：不 hideBuiltInItems，验证 Flash 是否自绘默认菜单（并触发 PPB_Flash_Menu）
  public class MenuProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;

    public function MenuProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 260; tf.textColor = 0x00FF00;
      tf.text = "right-click me (builtin items kept)";
      addChild(tf);

      var menu:ContextMenu = new ContextMenu();
      var a:ContextMenuItem = new ContextMenuItem("PROBE_ITEM_A", true, false, true);
      a.addEventListener(ContextMenuEvent.MENU_ITEM_SELECT, function(e:ContextMenuEvent):void {
        rep("menu", "SELECTED " + a.caption);
      });
      menu.customItems.push(a);
      this.contextMenu = menu;

      setTimeout(function():void { rep("menu", "ready"); }, 400);
      addEventListener(MouseEvent.CONTEXT_MENU, function(e:MouseEvent):void {
        rep("menu", "CONTEXT_MENU_EVENT");
      });
    }

    private function rep(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
