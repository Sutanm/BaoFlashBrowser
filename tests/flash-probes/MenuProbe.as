package {
  import flash.display.Sprite;
  import flash.events.ContextMenuEvent;
  import flash.events.MouseEvent;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.ui.ContextMenu;
  import flash.ui.ContextMenuBuiltInItems;
  import flash.ui.ContextMenuItem;
  import flash.text.TextField;
  import flash.utils.setTimeout;

  // 右键菜单探针：AS3 ContextMenu（走 PPB_Flash_Menu）
  public class MenuProbe extends Sprite {
    private static const REP:String = "http://127.0.0.1:8099/rep";
    private var tf:TextField;

    public function MenuProbe() {
      tf = new TextField(); tf.width = 700; tf.height = 260; tf.textColor = 0x00FF00;
      tf.text = "right-click me";
      addChild(tf);

      var menu:ContextMenu = new ContextMenu();
      menu.hideBuiltInItems();
      var a:ContextMenuItem = new ContextMenuItem("PROBE_ITEM_A", true, false, true);
      var b:ContextMenuItem = new ContextMenuItem("PROBE_ITEM_B", true, false, true);
      a.addEventListener(ContextMenuEvent.MENU_ITEM_SELECT, function(e:ContextMenuEvent):void {
        rep("menu", "SELECTED " + a.caption);
      });
      b.addEventListener(ContextMenuEvent.MENU_ITEM_SELECT, function(e:ContextMenuEvent):void {
        rep("menu", "SELECTED " + b.caption);
      });
      menu.customItems.push(a, b);
      this.contextMenu = menu;

      setTimeout(function():void { rep("menu", "ready (right-click the swf)"); }, 400);
      addEventListener(MouseEvent.CONTEXT_MENU, function(e:MouseEvent):void {
        rep("menu", "CONTEXT_MENU at " + e.stageX + "," + e.stageY);
      });
    }

    private function rep(tag:String, msg:String):void {
      try { new URLLoader().load(new URLRequest(REP + "?tag=" + encodeURIComponent(tag) + "&msg=" + encodeURIComponent(msg))); } catch (e:Error) {}
    }
  }
}
