/**
 * PiPiClaw - 启动占位页
 *
 * 仅在官方 OHOS Electron runtime 接管窗口之前短暂显示。
 * 真正的 UI 是 dist/index.html(Vue3 渲染进程,由 ArkWeb 承载)。
 */

@Entry
@Component
struct Index {
  @State message: string = 'PiPiClaw';
  @State hint: string = '正在启动 Electron 运行时…';

  build() {
    Column({ space: 12 }) {
      Image($r('app.media.startIcon'))
        .width(96)
        .height(96)
        .objectFit(ImageFit.Contain)

      Text(this.message)
        .fontSize(28)
        .fontWeight(FontWeight.Bold)

      Text(this.hint)
        .fontSize(14)
        .opacity(0.6)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor($r('app.color.start_window_background'))
  }
}
