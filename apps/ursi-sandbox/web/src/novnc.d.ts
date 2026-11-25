declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB {
    constructor(target: HTMLElement, url: string)
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    addEventListener(type: 'connect' | 'disconnect', handler: () => void): void
    removeEventListener(type: 'connect' | 'disconnect', handler: () => void): void
    disconnect(): void
  }
}
