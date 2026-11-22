package {
  import flash.display.Sprite;
  import flash.external.ExternalInterface;

  // Child SWF for the chained-load test: 2D only, so a failure isolates the
  // Loader path from Stage3D. Draws a magenta block and reports itself.
  public class S3DChild extends Sprite {
    public function S3DChild() {
      graphics.beginFill(0xFF00FF);
      graphics.drawRect(0, 0, 400, 300);
      graphics.endFill();
      trace("[s3dchild] loaded and drew");
      try { ExternalInterface.call("console.log", "[s3dchild] loaded and drew"); } catch (e:*) {}
    }
  }
}
