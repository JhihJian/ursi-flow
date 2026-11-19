declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB {
    constructor(target: HTMLElement, url: string)
    scaleViewport: boolean
    resizeSession: boolean
    disconnect(): void
  }
}
